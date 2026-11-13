// Booking-engine tests against a real Postgres. They create a throwaway shop and
// delete it afterwards. Opt in with:  RUN_DB_TESTS=1 npm test
// (uses DATABASE_URL: prefer a separate test database, never production.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { InvalidSlotError, SlotTakenError, cancelBookingById, createBooking, getOpenDays, getOpenSlots, loadService, rescheduleBooking } from "../app/models/booking.server";
import { addDays, localParts, zonedToUtc } from "../app/models/time.server";

const run = process.env.RUN_DB_TESTS === "1";
const DOMAIN = "bookwell-vitest.myshopify.com";
const cust = (n: number) => ({ name: `T${n}`, email: `t${n}@example.com` });

async function cleanup() {
  const s = await prisma.shop.findUnique({ where: { shopDomain: DOMAIN } });
  if (!s) return;
  await prisma.booking.deleteMany({ where: { shopId: s.id } });
  await prisma.shop.delete({ where: { id: s.id } });
}

describe.skipIf(!run)("booking engine (database)", () => {
  let shop: Awaited<ReturnType<typeof prisma.shop.create>>;
  let staffA: string;
  let staffB: string;
  let D1: string;
  const tz = "Asia/Karachi";

  beforeAll(async () => {
    await cleanup();
    shop = await prisma.shop.create({ data: { shopDomain: DOMAIN, timezone: tz } });
    D1 = addDays(localParts(new Date(), tz).dateStr, 3);
    const a = await prisma.staffMember.create({ data: { shopId: shop.id, name: "A" } });
    const b = await prisma.staffMember.create({ data: { shopId: shop.id, name: "B", position: 1 } });
    staffA = a.id;
    staffB = b.id;
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [a.id, b.id].map((staffId) => ({ staffId, weekday, startMinute: 540, endMinute: 1020 }))),
    });
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("books a slot, refuses overlaps and out-of-hours, and re-opens cancelled slots", async () => {
    const row = await prisma.service.create({ data: { shopId: shop.id, name: "Cut", durationMinutes: 60, staffIds: [staffA] } });
    const svc = (await loadService(shop.id, row.id))!;
    const at10 = zonedToUtc(D1, 600, tz);
    const [b] = await createBooking({ shop, service: svc, staffId: staffA, startsAt: at10, customer: cust(1) });
    await expect(createBooking({ shop, service: svc, staffId: staffA, startsAt: at10, customer: cust(2) })).rejects.toBeInstanceOf(SlotTakenError);
    await expect(createBooking({ shop, service: svc, staffId: staffA, startsAt: zonedToUtc(D1, 630, tz), customer: cust(2) })).rejects.toBeInstanceOf(SlotTakenError);
    await expect(createBooking({ shop, service: svc, staffId: staffA, startsAt: zonedToUtc(D1, 1200, tz), customer: cust(2) })).rejects.toBeInstanceOf(InvalidSlotError);
    await cancelBookingById(shop.id, b.id, "admin");
    expect(await createBooking({ shop, service: svc, staffId: staffA, startsAt: at10, customer: cust(3) })).toHaveLength(1);
  });

  it("lets exactly one of six simultaneous requests win the last slot", async () => {
    const row = await prisma.service.create({ data: { shopId: shop.id, name: "Race", durationMinutes: 60, staffIds: [staffB] } });
    const svc = (await loadService(shop.id, row.id))!;
    const at = zonedToUtc(D1, 660, tz);
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => createBooking({ shop, service: svc, staffId: staffB, startsAt: at, customer: cust(10 + i) })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("applies blocks, group capacity and reschedules", async () => {
    const row = await prisma.service.create({ data: { shopId: shop.id, name: "Yoga", type: "group", durationMinutes: 60, capacity: 3, maxQuantity: 3, staffMode: "none" } });
    await prisma.availabilityRule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ serviceId: row.id, weekday, startMinute: 600, endMinute: 720 })) });
    const svc = (await loadService(shop.id, row.id))!;
    const at = zonedToUtc(D1, 600, tz);
    await createBooking({ shop, service: svc, staffId: null, startsAt: at, quantity: 2, customer: cust(20) });
    await expect(createBooking({ shop, service: svc, staffId: null, startsAt: at, quantity: 2, customer: cust(21) })).rejects.toBeInstanceOf(SlotTakenError);
    const [last] = await createBooking({ shop, service: svc, staffId: null, startsAt: at, quantity: 1, customer: cust(22) });
    const slots = await getOpenSlots({ shop, service: svc, date: D1 });
    expect(slots[0].available).toBe(false);
    expect(slots[1].seatsLeft).toBe(3);
    const moved = await rescheduleBooking({ shop, bookingId: last.id, startsAt: zonedToUtc(D1, 660, tz) });
    expect(localParts(moved.startsAt, tz).minute).toBe(660);

    await prisma.blockedTime.create({ data: { shopId: shop.id, kind: "dates", startDate: D1, endDate: D1 } });
    expect(await getOpenSlots({ shop, service: svc, date: D1 })).toHaveLength(0);
    const days = await getOpenDays({ shop, service: svc, from: D1, to: addDays(D1, 1) });
    expect(days.map((d) => d.available)).toEqual([false, true]);
  });

  it("prices multi-day rentals, shares equipment stock and holds unpaid deposits", async () => {
    const boat = await prisma.resource.create({ data: { shopId: shop.id, name: "Boat", quantity: 1 } });
    const rental = await prisma.service.create({ data: { shopId: shop.id, name: "Boat rental", type: "multiday", staffMode: "none", resourceId: boat.id, minDays: 1, maxDays: 7, price: 100 } });
    await prisma.availabilityRule.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ serviceId: rental.id, weekday, startMinute: 0, endMinute: 1440 })) });
    const r = (await loadService(shop.id, rental.id))!;
    const S = addDays(D1, 10);
    const [rb] = await createBooking({ shop, service: r, staffId: null, date: S, endDate: addDays(S, 2), customer: cust(30) });
    expect(Number(rb.totalPrice)).toBe(300);
    await expect(createBooking({ shop, service: r, staffId: null, date: addDays(S, 2), endDate: addDays(S, 4), customer: cust(31) })).rejects.toBeInstanceOf(SlotTakenError);
    expect(await createBooking({ shop, service: r, staffId: null, date: addDays(S, 3), endDate: addDays(S, 4), customer: cust(32) })).toHaveLength(1);

    const dep = await prisma.service.create({ data: { shopId: shop.id, name: "Dep", durationMinutes: 60, price: 80, paymentMode: "deposit_percent", depositValue: 25, staffIds: [staffA] } });
    const d = (await loadService(shop.id, dep.id))!;
    const at = zonedToUtc(addDays(D1, 6), 900, tz);
    const [held] = await createBooking({ shop, service: d, staffId: staffA, startsAt: at, customer: cust(40) });
    expect(held.status).toBe("pending");
    expect(Number(held.amountDue)).toBe(20);
    await expect(createBooking({ shop, service: d, staffId: staffA, startsAt: at, customer: cust(41) })).rejects.toBeInstanceOf(SlotTakenError);
    await prisma.booking.update({ where: { id: held.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    expect(await createBooking({ shop, service: d, staffId: staffA, startsAt: at, customer: cust(42), source: "manual" })).toHaveLength(1);
  });
});
