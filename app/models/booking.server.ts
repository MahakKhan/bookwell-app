import prisma from "../db.server";

export interface SlotRequest {
  shopId: string;
  serviceId: string;
  staffId: string;
  startsAt: Date;
}

/**
 * The double-booking guard. Two layers, both required:
 *  1. The Booking.staffId+startsAt unique index in prisma/schema.prisma
 *     rejects a conflicting insert at the database level even under
 *     concurrent requests (two customers clicking "confirm" at once).
 *  2. This pre-check gives a clean error message instead of a raw
 *     constraint violation, and also catches overlapping-duration
 *     conflicts the unique index alone can't (e.g. a 45-min booking
 *     starting inside another staff member's existing slot).
 * This runs the same way regardless of plan — it is never gated
 * behind a paid tier, unlike the competitor this was built to beat.
 */
export async function assertSlotIsFree({
  staffId,
  startsAt,
  durationMinutes,
}: {
  staffId: string;
  startsAt: Date;
  durationMinutes: number;
}) {
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  const conflict = await prisma.booking.findFirst({
    where: {
      staffId,
      status: "confirmed",
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  });

  if (conflict) {
    throw new SlotTakenError();
  }
}

export class SlotTakenError extends Error {
  constructor() {
    super("That time was just booked by someone else. Pick another slot.");
    this.name = "SlotTakenError";
  }
}

export async function createBooking(input: {
  shopId: string;
  serviceId: string;
  staffId: string;
  locationId?: string | null;
  startsAt: Date;
  durationMinutes: number;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  smsOptIn: boolean;
}) {
  const endsAt = new Date(
    input.startsAt.getTime() + input.durationMinutes * 60_000,
  );

  // Serializable transaction: re-check for a conflict and insert in the
  // same transaction so two simultaneous requests can't both pass the
  // pre-check and then both insert. The unique index is the final
  // backstop if the database doesn't support SERIALIZABLE isolation.
  return prisma.$transaction(
    async (tx) => {
      const conflict = await tx.booking.findFirst({
        where: {
          staffId: input.staffId,
          status: "confirmed",
          startsAt: { lt: endsAt },
          endsAt: { gt: input.startsAt },
        },
        select: { id: true },
      });
      if (conflict) throw new SlotTakenError();

      return tx.booking.create({
        data: {
          shopId: input.shopId,
          serviceId: input.serviceId,
          staffId: input.staffId,
          locationId: input.locationId ?? null,
          startsAt: input.startsAt,
          endsAt,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          smsOptIn: input.smsOptIn,
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

/**
 * Looks a booking up by the capability token handed to the customer at
 * booking time, instead of by id alone — knowing a booking's id (which
 * leaks into URLs, emails, etc) must not be enough to cancel or move
 * someone else's appointment.
 */
export async function findBookingByToken(manageToken: string) {
  return prisma.booking.findUnique({
    where: { manageToken },
    include: { service: true, staff: true },
  });
}

export async function cancelBooking(manageToken: string) {
  const result = await prisma.booking.updateMany({
    where: { manageToken, status: "confirmed" },
    data: { status: "cancelled" },
  });
  return result.count > 0;
}

/**
 * Moves an existing confirmed booking to a new start time, re-running the
 * exact same conflict check createBooking uses so a reschedule can never
 * land on a slot someone else already holds.
 */
export async function rescheduleBooking({
  manageToken,
  startsAt,
  durationMinutes,
}: {
  manageToken: string;
  startsAt: Date;
  durationMinutes: number;
}) {
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  return prisma.$transaction(
    async (tx) => {
      const booking = await tx.booking.findUnique({ where: { manageToken } });
      if (!booking || booking.status !== "confirmed") {
        throw new BookingNotFoundError();
      }

      const conflict = await tx.booking.findFirst({
        where: {
          id: { not: booking.id },
          staffId: booking.staffId,
          status: "confirmed",
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { id: true },
      });
      if (conflict) throw new SlotTakenError();

      return tx.booking.update({
        where: { id: booking.id },
        data: { startsAt, endsAt },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

export class BookingNotFoundError extends Error {
  constructor() {
    super("That booking could not be found, or has already been cancelled.");
    this.name = "BookingNotFoundError";
  }
}

/**
 * The single source of truth for "what's open." The admin calendar,
 * the storefront widget, and the POS extension all call this same
 * function — the exact fix for the POS-shows-everything-as-available
 * bug this project was designed around.
 */
export async function getOpenSlots({
  shopId,
  serviceId,
  staffId,
  date,
  durationMinutes,
  slotStepMinutes = 30,
}: {
  shopId: string;
  serviceId: string;
  staffId: string;
  date: Date;
  durationMinutes: number;
  slotStepMinutes?: number;
}) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

  const [rules, existing] = await Promise.all([
    prisma.availabilityRule.findMany({
      where: { staffId, weekday: dayStart.getDay() },
    }),
    prisma.booking.findMany({
      where: {
        shopId,
        staffId,
        status: "confirmed",
        startsAt: { gte: dayStart, lt: dayEnd },
      },
      select: { startsAt: true, endsAt: true },
    }),
  ]);

  const slots: { startsAt: Date; available: boolean }[] = [];

  for (const rule of rules) {
    for (
      let minute = rule.startMinute;
      minute + durationMinutes <= rule.endMinute;
      minute += slotStepMinutes
    ) {
      const startsAt = new Date(dayStart.getTime() + minute * 60_000);
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

      const taken = existing.some(
        (b) => startsAt < b.endsAt && endsAt > b.startsAt,
      );

      slots.push({ startsAt, available: !taken });
    }
  }

  return slots;
}
