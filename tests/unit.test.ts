import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, localParts, weekdayOf, zonedToUtc } from "../app/models/time.server";
import { PLANS, parsePlan, seatsAllowed, subscriptionName, subscriptionPrice } from "../app/plans";
import { buildIcs } from "../app/models/ics.server";
import { validateSignature, WaiverError } from "../app/models/waivers.server";
import { validTwilioSignature } from "../app/models/voice.server";
import { decrypt, encrypt, signState, verifyState } from "../app/models/crypto.server";

describe("timezones", () => {
  it("converts wall-clock times across DST", () => {
    expect(zonedToUtc("2027-01-15", 9 * 60, "America/New_York").toISOString()).toBe("2027-01-15T14:00:00.000Z");
    expect(zonedToUtc("2027-07-15", 9 * 60, "America/New_York").toISOString()).toBe("2027-07-15T13:00:00.000Z");
    expect(zonedToUtc("2027-01-15", 9 * 60, "Asia/Karachi").toISOString()).toBe("2027-01-15T04:00:00.000Z");
  });
  it("round-trips local parts", () => {
    const d = zonedToUtc("2027-03-10", 17 * 60 + 30, "Australia/Sydney");
    expect(localParts(d, "Australia/Sydney")).toMatchObject({ dateStr: "2027-03-10", minute: 17 * 60 + 30 });
  });
  it("date helpers", () => {
    expect(addDays("2027-02-27", 2)).toBe("2027-03-01");
    expect(weekdayOf("2027-01-04")).toBe(1);
    expect(daysBetween("2027-01-01", "2027-01-31")).toBe(30);
  });
});

describe("plans", () => {
  it("parses plan names with extra seats", () => {
    expect(parsePlan("Growth +2 seats")).toMatchObject({ extraSeats: 2 });
    expect(parsePlan("Growth +2 seats").plan.key).toBe("growth");
    expect(parsePlan("free").plan.key).toBe("free");
    expect(parsePlan("Entry").plan.key).toBe("starter");
  });
  it("prices and seats", () => {
    const growth = PLANS.find((p) => p.key === "growth")!;
    expect(subscriptionPrice(growth, 2)).toBe(34.97);
    expect(parsePlan(subscriptionName(growth, 1)).extraSeats).toBe(1);
    expect(seatsAllowed("Growth +2 seats")).toBe(5);
    expect(seatsAllowed("free")).toBe(1);
  });
});

describe("calendar files", () => {
  const ics = buildIcs("Cal", [
    { uid: "a", title: "Massage; deep, tissue", startsAt: new Date("2027-01-05T15:00:00Z"), endsAt: new Date("2027-01-05T16:00:00Z") },
    { uid: "b", title: "Boat", startsAt: new Date(), endsAt: new Date(), allDay: { startDate: "2027-02-01", endDateExclusive: "2027-02-04" } },
  ]);
  it("escapes text, uses UTC and all-day dates", () => {
    expect(ics).toContain("SUMMARY:Massage\\; deep\\, tissue");
    expect(ics).toContain("DTSTART:20270105T150000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270201");
  });
  it("folds long lines to 75 octets with CRLF", () => {
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});

describe("waivers", () => {
  const png = "data:image/png;base64," + "A".repeat(2000);
  it("needs agreement, a name and a drawn signature", () => {
    expect(() => validateSignature({ agreed: false, name: "A", signature: png })).toThrow(WaiverError);
    expect(() => validateSignature({ agreed: true, name: "", signature: png })).toThrow(WaiverError);
    expect(() => validateSignature({ agreed: true, name: "A", signature: "data:image/png;base64,AA" })).toThrow(WaiverError);
    expect(validateSignature({ agreed: true, name: " Ann ", signature: png }).name).toBe("Ann");
  });
});

describe("twilio signature", () => {
  const token = "secret";
  const url = "https://example.com/voice/x?step=turn";
  const params = { CallSid: "CA1", SpeechResult: "hello" };
  const sig = crypto.createHmac("sha1", token).update(url + "CallSid" + "CA1" + "SpeechResult" + "hello").digest("base64");
  it("accepts valid and rejects tampered requests", () => {
    expect(validTwilioSignature(token, url, params, sig)).toBe(true);
    expect(validTwilioSignature(token, url, { ...params, SpeechResult: "x" }, sig)).toBe(false);
    expect(validTwilioSignature(token, url, params, null)).toBe(false);
  });
});

describe("crypto", () => {
  it("encrypts and decrypts; rejects tampering", () => {
    process.env.ENCRYPTION_KEY = "test-key";
    const c = encrypt("sk-123");
    expect(c).not.toContain("sk-123");
    expect(decrypt(c)).toBe("sk-123");
    expect(decrypt(c.slice(0, -2) + "xx")).toBeNull();
  });
  it("signed state carries the shop and rejects forgeries", () => {
    process.env.ENCRYPTION_KEY = "test-key";
    const s = signState("a.myshopify.com");
    expect(verifyState(s)).toBe("a.myshopify.com");
    expect(verifyState(s + "x")).toBeNull();
  });
});
