import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { assertCanTakeBooking } from "./billing.server";
import { WaiverError, activeWaiverForService, recordSignatures, validateSignature } from "./waivers.server";
import { InvalidSlotError, SlotTakenError, createBooking, isDayService, loadService } from "./booking.server";
import { onBookingsCreated } from "./lifecycle.server";
import { questionsFor } from "./storefront.server";
import { DATE_RE } from "./time.server";
import { consumeCredits, findUsablePackage, refundCredits } from "./packages.server";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SubmitError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * Validates a booking request from the widget / public API / team portal and
 * creates it. `body` is untrusted JSON.
 */
export async function submitBooking(
  shop: Shop,
  body: any,
  source: "widget" | "api" | "portal" | "pos" = "widget",
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const service = await loadService(shop.id, str(body.serviceId, 64));
  if (!service || !service.active || service.archived) throw new SubmitError("Service not found.", 404);

  const customerName = str(body.customerName, 120);
  const customerEmail = str(body.customerEmail, 200).toLowerCase();
  const customerPhone = str(body.customerPhone, 40);
  if (!customerName || !customerEmail) throw new SubmitError("Name and email are required.");
  if (!EMAIL_RE.test(customerEmail)) throw new SubmitError("Please enter a valid email address.");

  const blocked = await prisma.blockedEmail.findFirst({
    where: { shopId: shop.id, OR: [{ email: customerEmail }, { email: `@${customerEmail.split("@")[1]}` }] },
    select: { id: true },
  });
  if (blocked) throw new SubmitError("Bookings with this email address aren't accepted. Please contact the store.", 403);

  // Custom questions.
  const questions = await questionsFor(shop.id, service.id);
  const rawAnswers = (body.answers && typeof body.answers === "object" ? body.answers : {}) as Record<string, unknown>;
  const answers: { label: string; value: string }[] = [];
  for (const q of questions) {
    let value = rawAnswers[q.id];
    if (q.type === "checkbox") value = value === true || value === "true" || value === "on" ? "Yes" : "";
    const text = str(value, 2000);
    if (q.required && !text) throw new SubmitError(`Please answer: ${q.label}`);
    if (q.type === "select" && text && !q.options.includes(text)) throw new SubmitError(`Invalid answer for: ${q.label}`);
    if (text) answers.push({ label: q.label, value: text });
  }

  const startsAt = body.startsAt ? new Date(String(body.startsAt)) : undefined;
  const date = DATE_RE.test(String(body.date || "")) ? String(body.date) : undefined;
  const endDate = DATE_RE.test(String(body.endDate || "")) ? String(body.endDate) : undefined;
  if (isDayService(service) ? !date && !startsAt : !startsAt && !(Array.isArray(body.startsAtList) && body.startsAtList.length)) {
    throw new SubmitError("Pick a time.");
  }

  const recurrenceCount = Math.floor(Number(body.recurrence?.count) || 0);
  const recurrenceInterval = Math.floor(Number(body.recurrence?.intervalDays) || 7);
  const startsAtList = Array.isArray(body.startsAtList)
    ? body.startsAtList.slice(0, 50).map((v: unknown) => new Date(String(v)))
    : undefined;
  const sessions = Math.max(
    1,
    recurrenceCount > 1 ? Math.min(recurrenceCount, service.maxRecurrences) : 1,
    startsAtList ? Math.min(startsAtList.length, service.maxSlots) : 1,
  );

  // Waiver: must be read and signed before the booking is made.
  const waiver = await activeWaiverForService(service.id);
  let waiverSig: { name: string; signature: string } | null = null;
  if (waiver) {
    try {
      waiverSig = validateSignature(body.waiver);
    } catch (e) {
      if (e instanceof WaiverError) throw new SubmitError(e.message);
      throw e;
    }
  }

  // Plan limit (bookings per 30 days). Manual bookings never count.
  try {
    await assertCanTakeBooking(shop, sessions);
  } catch {
    throw new SubmitError("This store isn't taking online bookings right now. Please contact the store.", 403);
  }

  // Pay with a class pack / membership instead of checkout.
  let customerPackageId: string | null = null;
  if (body.usePackage) {
    const cp = await findUsablePackage(shop.id, customerEmail, service.id, sessions);
    if (!cp || !(await consumeCredits(cp.id, sessions))) {
      throw new SubmitError("No active package or membership with enough sessions was found for this email.", 402);
    }
    customerPackageId = cp.id;
  }

  try {
    const bookings = await createBooking({
      shop,
      service,
      staffId: body.staffId ? str(body.staffId, 64) : "any",
      startsAt: startsAt ?? startsAtList?.[0],
      startsAtList,
      date,
      endDate,
      customerPackageId,
      quantity: Number(body.quantity) || 1,
      addonIds: Array.isArray(body.addons) ? body.addons.map((a: unknown) => String(a)).slice(0, 20) : [],
      customer: {
        name: customerName,
        email: customerEmail,
        phone: customerPhone || null,
        smsOptIn: Boolean(body.smsOptIn) && Boolean(customerPhone) && shop.smsEnabled,
      },
      answers,
      notes: str(body.notes, 1000) || null,
      source,
      recurrence: recurrenceCount > 1 ? { count: recurrenceCount, intervalDays: [1, 7, 14, 28].includes(recurrenceInterval) ? recurrenceInterval : 7 } : null,
    });
    if (waiver && waiverSig) {
      await recordSignatures(bookings.map((b) => b.id), waiver, waiverSig, meta);
    }
    const { checkoutUrl } = await onBookingsCreated(shop, bookings);
    return { bookings, checkoutUrl, service };
  } catch (e) {
    if (customerPackageId) await refundCredits(customerPackageId, sessions);
    if (e instanceof SlotTakenError) throw new SubmitError(e.message, 409);
    if (e instanceof InvalidSlotError) throw new SubmitError(e.message, 400);
    if (e instanceof Error && /payment/i.test(e.message)) throw new SubmitError(e.message, 502);
    throw e;
  }
}
