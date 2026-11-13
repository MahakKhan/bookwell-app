import crypto from "node:crypto";
import type { BlockedTime, Booking, Prisma, PrismaClient, Resource, Service, ServiceAddon, Shop } from "@prisma/client";
import prisma from "../db.server";
import { addDays, daysBetween, localParts, weekdayOf, zonedToUtc } from "./time.server";

type Db = PrismaClient | Prisma.TransactionClient;

export class SlotTakenError extends Error {
  constructor(message = "That time was just booked by someone else. Pick another slot.") {
    super(message);
    this.name = "SlotTakenError";
  }
}

export class BookingNotFoundError extends Error {
  constructor() {
    super("That booking could not be found, or has already been cancelled.");
    this.name = "BookingNotFoundError";
  }
}

export class InvalidSlotError extends Error {
  constructor(message = "That time isn't available for booking.") {
    super(message);
    this.name = "InvalidSlotError";
  }
}

export type ServiceFull = Service & { addons: ServiceAddon[]; resource: Resource | null };

export const SERVICE_TYPES = [
  { value: "appointment", label: "Appointment", hint: "One customer per time slot (salons, coaching, medical)." },
  { value: "group", label: "Group / class", hint: "Several customers share a slot, up to a capacity (classes, tours, workshops)." },
  { value: "virtual", label: "Virtual meeting", hint: "Online session; the meeting link is sent with the confirmation." },
  { value: "event", label: "Event / ticket", hint: "Fixed times with limited seats (concerts, workshops, dinners)." },
  { value: "rental", label: "Rental (hourly)", hint: "Rent equipment, courts or rooms by the hour, limited by stock." },
  { value: "fullday", label: "Full day", hint: "Book whole days; no time slots (day passes, museum entry)." },
  { value: "multiday", label: "Multi-day", hint: "Pick a start and end date (car, boat, property or equipment rental)." },
] as const;

export const isDayService = (s: { type: string }) => s.type === "fullday" || s.type === "multiday";

/** Legacy helper: service length plus its own buffer. */
export function effectiveDuration(service: { durationMinutes: number; bufferMinutes: number }) {
  return service.durationMinutes + service.bufferMinutes;
}

export function bufferFor(shop: Pick<Shop, "globalBufferMinutes">, service: ServiceFull) {
  return Math.max(service.bufferMinutes, shop.globalBufferMinutes ?? 0) + (service.resource?.bufferMinutes ?? 0);
}

export function loadService(shopId: string, serviceId: string) {
  return prisma.service.findFirst({
    where: { id: serviceId, shopId },
    include: { addons: { where: { active: true }, orderBy: { position: "asc" } }, resource: true },
  });
}

/** Active team members who can perform this service, in display order. */
export function eligibleStaff(shopId: string, service: Pick<Service, "staffIds">) {
  return prisma.staffMember.findMany({
    where: { shopId, active: true, ...(service.staffIds.length ? { id: { in: service.staffIds } } : {}) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, bio: true },
  });
}

/**
 * Active services customers can't actually book, and why: no active team
 * member assigned, or (for services without staff) no opening hours.
 */
export async function unbookableServices(shopId: string) {
  const [services, staff, serviceRules] = await Promise.all([
    prisma.service.findMany({ where: { shopId, active: true, archived: false }, select: { id: true, name: true, staffMode: true, staffIds: true } }),
    prisma.staffMember.findMany({ where: { shopId, active: true }, select: { id: true, _count: { select: { availability: true } } } }),
    prisma.availabilityRule.groupBy({ by: ["serviceId"], where: { service: { shopId } }, _count: { _all: true } }),
  ]);
  const working = new Set(staff.filter((s) => s._count.availability > 0).map((s) => s.id));
  const active = new Set(staff.map((s) => s.id));
  const withHours = new Set(serviceRules.map((r) => r.serviceId));
  const out: { id: string; name: string; reason: string }[] = [];
  for (const s of services) {
    if (s.staffMode === "staff") {
      const pool = s.staffIds.length ? s.staffIds.filter((id) => active.has(id)) : [...active];
      if (!pool.length) out.push({ id: s.id, name: s.name, reason: "No active team member can perform it" });
      else if (!pool.some((id) => working.has(id))) out.push({ id: s.id, name: s.name, reason: "Its team members have no working hours" });
    } else if (!withHours.has(s.id)) {
      out.push({ id: s.id, name: s.name, reason: "It has no opening hours" });
    }
  }
  return out;
}

// A booking holds its time while confirmed (or done), and while an unpaid
// checkout is still within its hold window.
function occupyingWhere(now: Date): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: ["confirmed", "completed", "no_show"] } },
      { status: "pending", holdExpiresAt: { gt: now } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Windows: the exact span a booking would occupy.
// ---------------------------------------------------------------------------

type Window = {
  startsAt: Date;
  endsAt: Date; // includes buffer
  startDate: string;
  endDate: string; // inclusive, same as startDate for timed bookings
  minute: number;
  length: number; // minutes of actual service (no buffer)
};

function timedWindow(shop: Shop, service: ServiceFull, date: string, minute: number, addonMinutes: number): Window {
  const length = service.durationMinutes + addonMinutes;
  const startsAt = zonedToUtc(date, minute, shop.timezone);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + (length + bufferFor(shop, service)) * 60_000),
    startDate: date,
    endDate: date,
    minute,
    length,
  };
}

function dayWindow(shop: Shop, startDate: string, endDate: string): Window {
  return {
    startsAt: zonedToUtc(startDate, 0, shop.timezone),
    endsAt: zonedToUtc(addDays(endDate, 1), 0, shop.timezone),
    startDate,
    endDate,
    minute: 0,
    length: (daysBetween(startDate, endDate) + 1) * 1440,
  };
}

// ---------------------------------------------------------------------------
// Context: everything needed to judge availability over a date range, loaded
// in three parallel queries so evaluation can then run in memory.
// ---------------------------------------------------------------------------

type CtxBooking = Pick<Booking, "id" | "staffId" | "resourceId" | "serviceId" | "startsAt" | "endsAt" | "quantity">;

type Ctx = {
  shop: Shop;
  service: ServiceFull;
  staffId: string | null;
  rules: { weekday: number; startMinute: number; endMinute: number }[];
  blocks: BlockedTime[];
  bookings: CtxBooking[];
  busy: { startsAt: Date; endsAt: Date }[];
  todayStr: string;
};

async function loadCtx(
  db: Db,
  shop: Shop,
  service: ServiceFull,
  staffId: string | null,
  fromDate: string,
  toDate: string,
  excludeBookingId?: string,
): Promise<Ctx> {
  const now = new Date();
  // Bookings that end after the window starts can still overlap its first slot.
  const winStart = zonedToUtc(addDays(fromDate, -1), 0, shop.timezone);
  const winEnd = zonedToUtc(addDays(toDate, 2), 0, shop.timezone);
  const shopWide = Boolean(shop.maxPerSlot || shop.dailyBookingLimit);

  const pools: Prisma.BookingWhereInput[] = [{ serviceId: service.id }];
  if (staffId) pools.push({ staffId });
  if (service.resourceId) pools.push({ resourceId: service.resourceId });

  const scope: Prisma.BlockedTimeWhereInput[] = [
    { staffId: null, serviceId: null, resourceId: null },
    { serviceId: service.id },
  ];
  if (staffId) scope.push({ staffId });
  if (service.resourceId) scope.push({ resourceId: service.resourceId });

  const [rules, blocks, bookings, busy] = await Promise.all([
    db.availabilityRule.findMany({
      where: service.staffMode === "staff" && staffId ? { staffId } : { serviceId: service.id },
      select: { weekday: true, startMinute: true, endMinute: true },
      orderBy: { startMinute: "asc" },
    }),
    db.blockedTime.findMany({ where: { shopId: shop.id, OR: scope } }),
    db.booking.findMany({
      where: {
        shopId: shop.id,
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
        startsAt: { lt: winEnd },
        endsAt: { gt: winStart },
        AND: [occupyingWhere(now), shopWide ? {} : { OR: pools }],
      },
      select: { id: true, staffId: true, resourceId: true, serviceId: true, startsAt: true, endsAt: true, quantity: true },
    }),
    shop.googleBlockBusy || shop.outlookBlockBusy
      ? db.externalBusy.findMany({
          where: { shopId: shop.id, startsAt: { lt: winEnd }, endsAt: { gt: winStart } },
          select: { startsAt: true, endsAt: true },
        })
      : Promise.resolve([]),
  ]);

  return { shop, service, staffId, rules, blocks, bookings, busy, todayStr: localParts(now, shop.timezone).dateStr };
}

/** Highest number of units in use at any moment inside [s, e). */
function peakUsage(list: CtxBooking[], s: Date, e: Date) {
  const points = [s.getTime(), ...list.map((b) => b.startsAt.getTime()).filter((p) => p > s.getTime() && p < e.getTime())];
  let peak = 0;
  for (const p of points) {
    let used = 0;
    for (const b of list) if (b.startsAt.getTime() <= p && b.endsAt.getTime() > p) used += b.quantity;
    peak = Math.max(peak, used);
  }
  return peak;
}

type Verdict = { ok: boolean; seatsLeft: number; reason?: "closed" | "blocked" | "past" | "too_far" | "full" | "limit" };

function evaluate(ctx: Ctx, w: Window, quantity: number, opts: { ignoreHours?: boolean } = {}): Verdict {
  const { shop, service } = ctx;
  const now = Date.now();

  // --- booking window (notice / advance) ---
  if (!opts.ignoreHours) {
    if (w.startDate < ctx.todayStr) return { ok: false, seatsLeft: 0, reason: "past" };
    if (!isDayService(service) && w.startsAt.getTime() < now) return { ok: false, seatsLeft: 0, reason: "past" };
    if (service.minNoticeMinutes > 0 && w.startsAt.getTime() < now + service.minNoticeMinutes * 60_000) {
      return { ok: false, seatsLeft: 0, reason: "past" };
    }
    if (daysBetween(ctx.todayStr, w.startDate) > service.maxAdvanceDays) return { ok: false, seatsLeft: 0, reason: "too_far" };
  }

  // --- opening hours ---
  if (!opts.ignoreHours) {
    if (isDayService(service)) {
      for (let d = w.startDate; d <= w.endDate; d = addDays(d, 1)) {
        if (!ctx.rules.some((r) => r.weekday === weekdayOf(d))) return { ok: false, seatsLeft: 0, reason: "closed" };
      }
    } else {
      const wd = weekdayOf(w.startDate);
      const inside = ctx.rules.some(
        (r) => r.weekday === wd && w.minute >= r.startMinute && w.minute + w.length <= r.endMinute,
      );
      if (!inside) return { ok: false, seatsLeft: 0, reason: "closed" };
    }
  }

  // --- blocked dates and breaks ---
  if (!opts.ignoreHours) {
    for (const b of ctx.blocks) {
      if (b.kind === "dates") {
        const from = b.startDate ?? "0000-00-00";
        const to = b.endDate ?? from;
        if (from <= w.endDate && to >= w.startDate) return { ok: false, seatsLeft: 0, reason: "blocked" };
      } else if (b.kind === "break" && !isDayService(service)) {
        if (b.startMinute == null || b.endMinute == null) continue;
        if (b.startDate && b.startDate !== w.startDate) continue;
        if (b.weekday != null && b.weekday !== weekdayOf(w.startDate)) continue;
        if (w.minute < b.endMinute && w.minute + w.length > b.startMinute) {
          return { ok: false, seatsLeft: 0, reason: "blocked" };
        }
      }
    }
  }

  // --- busy in the merchant's Google Calendar (two-way sync) ---
  if (!opts.ignoreHours && ctx.busy.some((b) => b.startsAt < w.endsAt && b.endsAt > w.startsAt)) {
    return { ok: false, seatsLeft: 0, reason: "blocked" };
  }

  // --- capacity ---
  const overlap = ctx.bookings.filter((b) => b.startsAt < w.endsAt && b.endsAt > w.startsAt);
  let seatsLeft = Number.POSITIVE_INFINITY;

  if (ctx.staffId) {
    const mine = overlap.filter((b) => b.staffId === ctx.staffId);
    const foreign = mine.some((b) => b.serviceId !== service.id || b.startsAt.getTime() !== w.startsAt.getTime());
    seatsLeft = foreign ? 0 : Math.min(seatsLeft, service.capacity - mine.reduce((n, b) => n + b.quantity, 0));
  }
  if (service.resource) {
    const used = peakUsage(overlap.filter((b) => b.resourceId === service.resourceId), w.startsAt, w.endsAt);
    seatsLeft = Math.min(seatsLeft, service.resource.quantity - used);
  } else if (!ctx.staffId) {
    const used = peakUsage(overlap.filter((b) => b.serviceId === service.id), w.startsAt, w.endsAt);
    seatsLeft = Math.min(seatsLeft, service.capacity - used);
  }
  if (shop.maxPerSlot) seatsLeft = Math.min(seatsLeft, shop.maxPerSlot - overlap.length);

  // --- daily limits (counted by booking, in shop time) ---
  if (!opts.ignoreHours && (shop.dailyBookingLimit || service.dailyLimit)) {
    const sameDay = ctx.bookings.filter((b) => localParts(b.startsAt, shop.timezone).dateStr === w.startDate);
    if (shop.dailyBookingLimit && sameDay.length >= shop.dailyBookingLimit) return { ok: false, seatsLeft: 0, reason: "limit" };
    if (service.dailyLimit && sameDay.filter((b) => b.serviceId === service.id).length >= service.dailyLimit) {
      return { ok: false, seatsLeft: 0, reason: "limit" };
    }
  }

  seatsLeft = Math.max(0, seatsLeft);
  return { ok: seatsLeft >= quantity, seatsLeft, reason: seatsLeft >= quantity ? undefined : "full" };
}

const REASON_TEXT: Record<string, string> = {
  closed: "That time is outside opening hours.",
  blocked: "That date or time is blocked.",
  past: "That time is too soon or in the past.",
  too_far: "That date is too far ahead to book yet.",
  limit: "The booking limit for that day has been reached.",
};

function verdictError(v: Verdict) {
  if (v.reason === "full" || !v.reason) return new SlotTakenError(v.seatsLeft > 0 ? `Only ${v.seatsLeft} spot(s) left at that time.` : undefined);
  return new InvalidSlotError(REASON_TEXT[v.reason]);
}

// ---------------------------------------------------------------------------
// Public read API: slots for a day, open days for a calendar month.
// ---------------------------------------------------------------------------

async function staffCandidates(shop: Shop, service: ServiceFull, staffId: string | null | undefined) {
  if (service.staffMode === "none") return [null];
  const staff = await eligibleStaff(shop.id, service);
  if (staffId && staffId !== "any") return staff.some((s) => s.id === staffId) ? [staffId] : [];
  return staff.map((s) => s.id);
}

export type Slot = { startsAt: Date; available: boolean; seatsLeft: number; staffId: string | null };

function slotsFromCtx(ctx: Ctx, date: string, quantity: number, addonMinutes: number): Slot[] {
  const { shop, service } = ctx;
  if (isDayService(service)) {
    const v = evaluate(ctx, dayWindow(shop, date, date), quantity);
    if (v.reason && ["closed", "past", "too_far"].includes(v.reason)) return [];
    return [{ startsAt: zonedToUtc(date, 0, shop.timezone), available: v.ok, seatsLeft: v.seatsLeft, staffId: ctx.staffId }];
  }
  const length = service.durationMinutes + addonMinutes;
  const step = Math.max(5, service.slotStepMinutes || length + bufferFor(shop, service));
  const out: Slot[] = [];
  const wd = weekdayOf(date);
  for (const rule of ctx.rules.filter((r) => r.weekday === wd)) {
    for (let minute = rule.startMinute; minute + length <= rule.endMinute; minute += step) {
      const w = timedWindow(shop, service, date, minute, addonMinutes);
      const v = evaluate(ctx, w, quantity);
      if (v.reason && ["closed", "past", "too_far", "blocked"].includes(v.reason)) continue;
      out.push({ startsAt: w.startsAt, available: v.ok, seatsLeft: v.seatsLeft, staffId: ctx.staffId });
    }
  }
  return out;
}

function mergeSlots(lists: Slot[][]) {
  const map = new Map<number, Slot>();
  for (const list of lists) {
    for (const s of list) {
      const k = s.startsAt.getTime();
      const prev = map.get(k);
      if (!prev || (!prev.available && s.available) || (prev.available === s.available && s.seatsLeft > prev.seatsLeft)) {
        map.set(k, s);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Single source of truth for "what's open" — used by the storefront widget,
 * the manage page, manual bookings and POS. `date` is "YYYY-MM-DD" in shop
 * time. staffId "any" (or null) merges every eligible team member.
 */
export async function getOpenSlots(args: {
  shop: Shop;
  service: ServiceFull;
  staffId?: string | null;
  date: string;
  quantity?: number;
  addonMinutes?: number;
  excludeBookingId?: string;
}) {
  const { shop, service, date } = args;
  const quantity = Math.max(1, args.quantity ?? 1);
  const candidates = await staffCandidates(shop, service, args.staffId);
  const lists = await Promise.all(
    candidates.map(async (sid) => {
      const ctx = await loadCtx(prisma, shop, service, sid, date, date, args.excludeBookingId);
      return slotsFromCtx(ctx, date, quantity, args.addonMinutes ?? 0);
    }),
  );
  return mergeSlots(lists);
}

/** Every slot from `from` to `to` (inclusive), loading the data once. */
export async function getSlotsRange(args: { shop: Shop; service: ServiceFull; from: string; to: string }) {
  const { shop, service, from, to } = args;
  const candidates = await staffCandidates(shop, service, null);
  const ctxs = await Promise.all(candidates.map((sid) => loadCtx(prisma, shop, service, sid, from, to)));
  const out: { date: string; slots: Slot[] }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const slots = mergeSlots(ctxs.map((ctx) => slotsFromCtx(ctx, d, 1, 0)));
    if (slots.length) out.push({ date: d, slots });
  }
  return out;
}

/** Which dates in [from, to] have at least one bookable slot (for calendars). */
export async function getOpenDays(args: {
  shop: Shop;
  service: ServiceFull;
  staffId?: string | null;
  from: string;
  to: string;
  quantity?: number;
}) {
  const { shop, service, from, to } = args;
  const quantity = Math.max(1, args.quantity ?? 1);
  const candidates = await staffCandidates(shop, service, args.staffId);
  const ctxs = await Promise.all(candidates.map((sid) => loadCtx(prisma, shop, service, sid, from, to)));
  const days: { date: string; available: boolean }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const available = ctxs.some((ctx) => slotsFromCtx(ctx, d, quantity, 0).some((s) => s.available));
    days.push({ date: d, available });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function lock(tx: Prisma.TransactionClient, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) x`;
  }
}

function lockKeys(shop: Shop, service: ServiceFull, staffId: string | null) {
  const keys = [`service:${service.id}`];
  if (staffId) keys.push(`staff:${staffId}`);
  if (service.resourceId) keys.push(`resource:${service.resourceId}`);
  if (shop.maxPerSlot || shop.dailyBookingLimit) keys.push(`shop:${shop.id}`);
  return keys;
}

const TX_OPTS = { maxWait: 15_000, timeout: 30_000 };

export function money(n: number) {
  return Math.round(n * 100) / 100;
}

/** Price of one booking and how much of it is charged at checkout. */
export function priceFor(service: ServiceFull, opts: { quantity: number; addons: ServiceAddon[]; days: number }) {
  const unit = Number(service.price) + opts.addons.reduce((n, a) => n + Number(a.price), 0);
  const total = money(unit * opts.quantity * (service.type === "multiday" ? opts.days : 1));
  let due = 0;
  if (service.paymentMode === "full") due = total;
  else if (service.paymentMode === "deposit_percent") due = money((total * Number(service.depositValue)) / 100);
  else if (service.paymentMode === "deposit_fixed") due = Math.min(total, money(Number(service.depositValue)));
  return { total, due };
}

export async function upsertCustomer(shopId: string, c: { name: string; email: string; phone?: string | null }) {
  const email = c.email.trim().toLowerCase();
  return prisma.customer.upsert({
    where: { shopId_email: { shopId, email } },
    update: { name: c.name, ...(c.phone ? { phone: c.phone } : {}) },
    create: { shopId, email, name: c.name, phone: c.phone || null },
  });
}

export type CreateBookingInput = {
  shop: Shop;
  service: ServiceFull;
  staffId: string | null | "any";
  startsAt?: Date; // timed services
  startsAtList?: Date[]; // multi-slot bundle: several times in one booking
  date?: string; // day services: start date
  endDate?: string; // multiday: last day (inclusive)
  quantity?: number;
  addonIds?: string[];
  customer: { name: string; email: string; phone?: string | null; smsOptIn?: boolean };
  answers?: { label: string; value: string }[];
  notes?: string | null;
  source?: "widget" | "manual" | "pos" | "api" | "portal";
  recurrence?: { count: number; intervalDays: number } | null;
  ignoreHours?: boolean; // merchant override for manual bookings
  markPaid?: boolean;
  customerPackageId?: string | null; // paid with a package / membership
};

/**
 * Creates one booking (or a recurring series). Double-booking protection:
 * inside one transaction it takes an advisory lock on every pool the booking
 * draws from (team member, equipment, service, shop limits), re-reads what's
 * booked and re-checks capacity before inserting. Two customers racing for
 * the last seat therefore queue on the lock and the second one is refused.
 * Same on every plan — never behind a paywall.
 */
export async function createBooking(input: CreateBookingInput): Promise<Booking[]> {
  const { shop, service } = input;
  if (!service.active || service.archived) throw new InvalidSlotError("This service isn't available for booking.");

  const manual = input.source === "manual";
  const maxQ = manual ? Math.max(service.capacity, service.resource?.quantity ?? 1, service.maxQuantity) : service.maxQuantity;
  const quantity = Math.min(Math.max(1, Math.floor(input.quantity ?? 1)), Math.max(1, maxQ));
  const addons = service.addons.filter((a) => (input.addonIds ?? []).includes(a.id));
  const addonMinutes = addons.reduce((n, a) => n + a.durationMinutes, 0);

  // Build the first window.
  let first: Window;
  if (isDayService(service)) {
    const startDate = input.date || (input.startsAt ? localParts(input.startsAt, shop.timezone).dateStr : "");
    const endDate = service.type === "multiday" ? input.endDate || startDate : startDate;
    if (!startDate || endDate < startDate) throw new InvalidSlotError("Pick a valid date range.");
    const days = daysBetween(startDate, endDate) + 1;
    if (service.type === "multiday" && !manual && (days < service.minDays || days > service.maxDays)) {
      throw new InvalidSlotError(`Bookings must be between ${service.minDays} and ${service.maxDays} days.`);
    }
    first = dayWindow(shop, startDate, endDate);
  } else {
    if (!input.startsAt || Number.isNaN(input.startsAt.getTime())) throw new InvalidSlotError("Invalid date.");
    const lp = localParts(input.startsAt, shop.timezone);
    first = timedWindow(shop, service, lp.dateStr, lp.minute, addonMinutes);
  }

  // Recurring series: same local time every N days.
  const windows = [first];
  if (input.startsAtList && input.startsAtList.length > 1 && !isDayService(service)) {
    if (!service.allowMultiSlot && !manual) throw new InvalidSlotError("This service takes one time per booking.");
    const seen = new Set([first.startsAt.getTime()]);
    for (const at of input.startsAtList.slice(0, Math.max(1, service.maxSlots))) {
      if (Number.isNaN(at.getTime()) || seen.has(at.getTime())) continue;
      seen.add(at.getTime());
      const lp = localParts(at, shop.timezone);
      windows.push(timedWindow(shop, service, lp.dateStr, lp.minute, addonMinutes));
    }
  }
  const rec = input.recurrence;
  if (rec && rec.count > 1 && (service.allowRecurring || manual) && !isDayService(service)) {
    const count = Math.min(rec.count, Math.max(1, service.maxRecurrences), 52);
    for (let i = 1; i < count; i++) {
      const date = addDays(first.startDate, i * Math.max(1, rec.intervalDays));
      windows.push(timedWindow(shop, service, date, first.minute, addonMinutes));
    }
  }

  const days = daysBetween(first.startDate, first.endDate) + 1;
  const { total, due } = priceFor(service, { quantity, addons, days });
  const needsPayment = due > 0 && !manual && !input.markPaid && !input.customerPackageId;
  const customer = await upsertCustomer(shop.id, input.customer);
  const candidates = await staffCandidates(shop, service, input.staffId === "any" ? null : input.staffId);
  if (!candidates.length) throw new InvalidSlotError("No team member is available for this service.");

  const seriesId = windows.length > 1 ? crypto.randomUUID() : null;
  const holdExpiresAt = needsPayment ? new Date(Date.now() + Math.max(5, shop.holdMinutes) * 60_000) : null;

  return prisma.$transaction(async (tx) => {
    let firstFailure: Verdict | null = null;
    for (const staffId of candidates) {
      await lock(tx, lockKeys(shop, service, staffId));
      const verdicts: Verdict[] = [];
      for (const w of windows) {
        const ctx = await loadCtx(tx, shop, service, staffId, w.startDate, w.endDate);
        verdicts.push(evaluate(ctx, w, quantity, { ignoreHours: input.ignoreHours }));
      }
      const bad = verdicts.find((v) => !v.ok);
      if (bad) {
        firstFailure ??= bad;
        continue;
      }

      const created: Booking[] = [];
      for (const w of windows) {
        created.push(
          await tx.booking.create({
            data: {
              shopId: shop.id,
              serviceId: service.id,
              staffId,
              resourceId: service.resourceId,
              customerId: customer.id,
              startsAt: w.startsAt,
              endsAt: w.endsAt,
              status: needsPayment ? "pending" : "confirmed",
              quantity,
              customerName: input.customer.name,
              customerEmail: input.customer.email.trim().toLowerCase(),
              customerPhone: input.customer.phone || null,
              smsOptIn: Boolean(input.customer.smsOptIn),
              answers: input.answers?.length ? input.answers : undefined,
              addons: addons.length
                ? addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price), durationMinutes: a.durationMinutes }))
                : undefined,
              notes: input.notes || null,
              source: input.source ?? "widget",
              seriesId,
              totalPrice: total,
              amountDue: due,
              paymentStatus: needsPayment ? "pending" : (input.markPaid || input.customerPackageId) && total > 0 ? "paid" : "none",
              customerPackageId: input.customerPackageId ?? null,
              holdExpiresAt,
              meetingUrl: service.meetingUrl,
            },
          }),
        );
      }
      return created;
    }
    throw verdictError(firstFailure ?? { ok: false, seatsLeft: 0, reason: "full" });
  }, TX_OPTS);
}

/** Moves a booking to a new time/date, re-running the same checks under lock. */
export async function rescheduleBooking(args: {
  shop: Shop;
  bookingId: string;
  startsAt?: Date;
  date?: string;
  endDate?: string;
  staffId?: string | null;
  ignoreHours?: boolean;
}) {
  const { shop } = args;
  const booking = await prisma.booking.findFirst({ where: { id: args.bookingId, shopId: shop.id } });
  if (!booking || !["confirmed", "pending"].includes(booking.status)) throw new BookingNotFoundError();
  const service = await loadService(shop.id, booking.serviceId);
  if (!service) throw new BookingNotFoundError();

  const addonMinutes = Array.isArray(booking.addons)
    ? (booking.addons as { durationMinutes?: number }[]).reduce((n, a) => n + (a.durationMinutes || 0), 0)
    : 0;
  let w: Window;
  if (isDayService(service)) {
    const startDate = args.date || (args.startsAt ? localParts(args.startsAt, shop.timezone).dateStr : "");
    if (!startDate) throw new InvalidSlotError("Pick a date.");
    const oldDays = daysBetween(localParts(booking.startsAt, shop.timezone).dateStr, localParts(new Date(booking.endsAt.getTime() - 1), shop.timezone).dateStr);
    const endDate = service.type === "multiday" ? args.endDate || addDays(startDate, oldDays) : startDate;
    w = dayWindow(shop, startDate, endDate);
  } else {
    if (!args.startsAt || Number.isNaN(args.startsAt.getTime())) throw new InvalidSlotError("Invalid date.");
    const lp = localParts(args.startsAt, shop.timezone);
    w = timedWindow(shop, service, lp.dateStr, lp.minute, addonMinutes);
  }
  const staffId = args.staffId !== undefined ? args.staffId : booking.staffId;

  return prisma.$transaction(async (tx) => {
    await lock(tx, lockKeys(shop, service, staffId));
    const ctx = await loadCtx(tx, shop, service, staffId, w.startDate, w.endDate, booking.id);
    const v = evaluate(ctx, w, booking.quantity, { ignoreHours: args.ignoreHours });
    if (!v.ok) throw verdictError(v);
    return tx.booking.update({
      where: { id: booking.id },
      data: { startsAt: w.startsAt, endsAt: w.endsAt, staffId, reminderSentAt: null },
    });
  }, TX_OPTS);
}

/** Looks a booking up by its capability token — the id alone is never enough. */
export async function findBookingByToken(manageToken: string) {
  return prisma.booking.findUnique({
    where: { manageToken },
    include: { service: true, staff: true, shop: true },
  });
}

/** Cancels if still active. Returns the booking as it was, or null. */
export async function cancelBookingById(shopId: string, bookingId: string, by: "customer" | "admin" | "system") {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, shopId } });
  if (!booking) return null;
  const result = await prisma.booking.updateMany({
    where: { id: bookingId, shopId, status: { in: ["confirmed", "pending"] } },
    data: { status: "cancelled", cancelledAt: new Date(), cancelledBy: by },
  });
  return result.count > 0 ? booking : null;
}

/** Customer-facing manage link: goes through the storefront app proxy, not the app server. */
export function manageUrlFor(shopDomain: string, token: string) {
  return `https://${shopDomain}/apps/booking/manage?token=${encodeURIComponent(token)}`;
}
