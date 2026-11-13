-- Group bookings let several customers share one (staffId, startsAt), so the
-- plain unique index from the init migration has to go. Overlap/capacity is
-- enforced in createBooking() under a per-pool advisory lock instead.
DROP INDEX IF EXISTS "Booking_staffId_startsAt_key";

CREATE INDEX IF NOT EXISTS "Booking_staffId_startsAt_idx" ON "Booking"("staffId", "startsAt");
