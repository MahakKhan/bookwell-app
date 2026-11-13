import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt } from "./crypto.server";
import { formatInTz } from "./time.server";

// Bring-your-own-provider notifications: Resend for email, Twilio for SMS and
// WhatsApp. Every send is logged to NotificationLog (the history tabs) and
// swallows provider errors — a flaky notification must never roll back a real
// appointment. Times are always rendered in the SHOP's timezone.

export type Kind = "confirmation" | "reminder" | "cancellation" | "reschedule" | "waitlist" | "merchant" | "test" | "payment";

export type NotifyBooking = {
  id?: string;
  customerEmail: string;
  customerName: string;
  customerPhone?: string | null;
  serviceName: string;
  staffName?: string | null;
  startsAt: Date;
  endsAt?: Date;
  allDay?: boolean;
  quantity?: number;
  manageUrl?: string;
  qrUrl?: string;
  icsUrl?: string;
  meetingUrl?: string | null;
  checkoutUrl?: string | null;
};

async function log(shop: Shop, entry: { bookingId?: string; channel: string; kind: string; to: string; subject?: string; status: string; error?: string }) {
  try {
    await prisma.notificationLog.create({ data: { shopId: shop.id, ...entry, error: entry.error?.slice(0, 500) } });
  } catch {
    // logging must never break a send
  }
}

export async function sendEmail(shop: Shop, to: string, subject: string, html: string, kind: Kind, bookingId?: string) {
  const apiKey = decrypt(shop.resendApiKey);
  if (!apiKey || !shop.notifyFromEmail) {
    await log(shop, { bookingId, channel: "email", kind, to, subject, status: "skipped", error: "Email provider not configured" });
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: shop.notifyFromEmail, to, subject, html }),
    });
    await log(shop, { bookingId, channel: "email", kind, to, subject, status: res.ok ? "sent" : "failed", error: res.ok ? undefined : await res.text() });
    return res.ok;
  } catch (e) {
    await log(shop, { bookingId, channel: "email", kind, to, subject, status: "failed", error: String(e) });
    return false;
  }
}

async function twilio(shop: Shop, from: string, to: string, body: string, channel: "sms" | "whatsapp", kind: Kind, bookingId?: string) {
  const authToken = decrypt(shop.twilioAuthToken);
  if (!shop.twilioAccountSid || !authToken || !from) {
    await log(shop, { bookingId, channel, kind, to, status: "skipped", error: "Twilio not configured" });
    return false;
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(shop.twilioAccountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${shop.twilioAccountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: channel === "whatsapp" ? `whatsapp:${from}` : from,
          To: channel === "whatsapp" ? `whatsapp:${to}` : to,
          Body: body,
        }),
      },
    );
    await log(shop, { bookingId, channel, kind, to, status: res.ok ? "sent" : "failed", error: res.ok ? undefined : await res.text() });
    return res.ok;
  } catch (e) {
    await log(shop, { bookingId, channel, kind, to, status: "failed", error: String(e) });
    return false;
  }
}

export function sendSms(shop: Shop, to: string, body: string, kind: Kind, bookingId?: string) {
  return twilio(shop, shop.twilioFromNumber || "", to, body, "sms", kind, bookingId);
}

export function sendWhatsapp(shop: Shop, to: string, body: string, kind: Kind, bookingId?: string) {
  if (!shop.whatsappEnabled) return Promise.resolve(false);
  return twilio(shop, shop.twilioWhatsappFrom || "", to, body, "whatsapp", kind, bookingId);
}

export function whenText(shop: Shop, b: Pick<NotifyBooking, "startsAt" | "endsAt" | "allDay">, short = false) {
  if (b.allDay) {
    const opts: Intl.DateTimeFormatOptions = { weekday: short ? "short" : "long", month: short ? "short" : "long", day: "numeric", timeZone: "UTC" };
    const from = formatInTz(b.startsAt, shop.timezone, { weekday: opts.weekday, month: opts.month, day: "numeric" });
    if (b.endsAt) {
      const last = formatInTz(new Date(b.endsAt.getTime() - 60_000), shop.timezone, { weekday: opts.weekday, month: opts.month, day: "numeric" });
      if (last !== from) return `${from} – ${last}`;
    }
    return from;
  }
  return formatInTz(
    b.startsAt,
    shop.timezone,
    short
      ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: !shop.use24h }
      : { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: !shop.use24h },
  );
}

const COPY: Record<Kind, { subject: (s: string) => string; title: string; lead: string; sms: (s: string, w: string) => string }> = {
  confirmation: {
    subject: (s) => `Booking confirmed: ${s}`,
    title: "Booking confirmed",
    lead: "you're booked in.",
    sms: (s, w) => `Your ${s} booking is confirmed for ${w}.`,
  },
  reminder: {
    subject: (s) => `Reminder: ${s} is coming up`,
    title: "See you soon",
    lead: "just a reminder about your upcoming booking.",
    sms: (s, w) => `Reminder: your ${s} booking is on ${w}.`,
  },
  cancellation: {
    subject: (s) => `Booking cancelled: ${s}`,
    title: "Booking cancelled",
    lead: "your booking has been cancelled.",
    sms: (s, w) => `Your ${s} booking on ${w} has been cancelled.`,
  },
  reschedule: {
    subject: (s) => `Booking moved: ${s}`,
    title: "Booking rescheduled",
    lead: "your booking has a new time.",
    sms: (s, w) => `Your ${s} booking has moved to ${w}.`,
  },
  waitlist: {
    subject: (s) => `A spot opened up: ${s}`,
    title: "A spot just opened",
    lead: "a place you were waiting for is now free. Book it before someone else does.",
    sms: (s, w) => `A spot opened for ${s} on ${w}. Book now before it's gone.`,
  },
  payment: {
    subject: (s) => `Complete your booking: ${s}`,
    title: "Almost there",
    lead: "your time is held for a short while. Complete payment to confirm it.",
    sms: (s, w) => `Complete payment to confirm your ${s} booking on ${w}.`,
  },
  merchant: {
    subject: (s) => `New booking: ${s}`,
    title: "New booking",
    lead: "a customer just booked.",
    sms: (s, w) => `New booking: ${s} on ${w}.`,
  },
  test: {
    subject: () => "Bookwell test email",
    title: "It works",
    lead: "your email settings are working.",
    sms: () => "Bookwell test message: your SMS settings are working.",
  },
};

export async function notifyCustomer(shop: Shop, kind: Kind, b: NotifyBooking, opts: { sms?: boolean } = {}) {
  const copy = COPY[kind];
  const subject = kind === "confirmation" && shop.emailConfirmSubject ? shop.emailConfirmSubject.replace("{service}", b.serviceName) : copy.subject(b.serviceName);
  const lead = kind === "confirmation" && shop.emailConfirmIntro ? shop.emailConfirmIntro : copy.lead;
  const email = sendEmail(shop, b.customerEmail, subject, emailHtml(shop, b, copy.title, lead, kind), kind, b.id);
  const tasks: Promise<boolean>[] = [email];
  if (b.customerPhone) {
    const text = copy.sms(b.serviceName, whenText(shop, b, true));
    if (opts.sms && shop.smsEnabled) tasks.push(sendSms(shop, b.customerPhone, text, kind, b.id));
    if (shop.whatsappEnabled) tasks.push(sendWhatsapp(shop, b.customerPhone, text, kind, b.id));
  }
  const results = await Promise.all(tasks);
  return results.some(Boolean);
}

export async function notifyMerchant(shop: Shop, b: NotifyBooking) {
  if (!shop.notifyMerchantEmail) return false;
  return sendEmail(shop, shop.notifyMerchantEmail, COPY.merchant.subject(b.serviceName), emailHtml(shop, b, "New booking", `${escapeHtml(b.customerName)} (${escapeHtml(b.customerEmail)}) just booked.`, "merchant"), "merchant", b.id);
}

// Kept for older callers.
export const sendBookingReminderEmail = (shop: Shop, b: NotifyBooking) => notifyCustomer(shop, "reminder", b);
export const sendBookingReminderSms = (shop: Shop, b: { customerPhone: string; serviceName: string; startsAt: Date }) =>
  sendSms(shop, b.customerPhone, COPY.reminder.sms(b.serviceName, whenText(shop, b, true)), "reminder");

function emailHtml(shop: Shop, b: NotifyBooking, title: string, lead: string, kind: Kind) {
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(shop.widgetAccent) ? shop.widgetAccent : "#5b5bd6";
  const when = whenText(shop, b);
  const rows = [
    b.staffName ? `<p style="color:#666;margin:4px 0 0">with ${escapeHtml(b.staffName)}</p>` : "",
    b.quantity && b.quantity > 1 ? `<p style="color:#666;margin:4px 0 0">${b.quantity} spots</p>` : "",
    b.meetingUrl && kind !== "cancellation" ? `<p style="margin:8px 0 0"><a href="${escapeHtml(b.meetingUrl)}" style="color:${accent};font-weight:600">Join online meeting</a></p>` : "",
  ].join("");
  const cta =
    kind === "payment" && b.checkoutUrl
      ? `<a href="${escapeHtml(b.checkoutUrl)}" style="display:inline-block;background:${accent};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Complete payment</a>`
      : kind === "waitlist" && b.manageUrl
        ? `<a href="${escapeHtml(b.manageUrl)}" style="color:${accent};font-weight:600">Book this spot</a>`
        : b.manageUrl && kind !== "cancellation" && kind !== "merchant"
          ? `<a href="${escapeHtml(b.manageUrl)}" style="color:${accent};font-weight:600">Reschedule or cancel this booking</a>`
          : "";
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto;color:#201f3d">
      <h2 style="margin:0 0 4px">${escapeHtml(title)}</h2>
      <p style="color:#666">Hi ${escapeHtml(b.customerName)}, ${lead}</p>
      <div style="background:#f6f5fb;border-radius:12px;padding:16px;margin:16px 0">
        <p style="font-weight:700;margin:0 0 4px">${escapeHtml(b.serviceName)}</p>
        <p style="color:${accent};font-weight:600;margin:0">${escapeHtml(when)}${b.allDay ? "" : ` (${escapeHtml(shop.timezone)})`}</p>
        ${rows}
      </div>
      ${cta}
      ${b.icsUrl && (kind === "confirmation" || kind === "reschedule" || kind === "reminder") ? `<p style="margin:12px 0 0"><a href="${escapeHtml(b.icsUrl)}" style="color:#666;font-size:13px">Add to calendar (Apple, Google, Outlook)</a></p>` : ""}
      ${b.qrUrl && (kind === "confirmation" || kind === "reminder") ? `<div style="margin-top:18px;text-align:center"><img src="${escapeHtml(b.qrUrl)}" width="140" height="140" alt="Your ticket QR code"><p style="color:#666;font-size:12px;margin:4px 0 0">Show this code at check-in</p></div>` : ""}
    </div>`;
}

export function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
