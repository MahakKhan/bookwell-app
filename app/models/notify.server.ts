import type { Shop } from "@prisma/client";

// Bring-your-own-provider notifications: Resend for email, Twilio for
// SMS. Both are plain REST calls (no SDK dependency) and both are
// optional — a shop with no keys configured just gets no message, never
// a broken booking. Every call here is wrapped in try/catch by its
// caller's expectations: these functions swallow their own provider
// errors and resolve to a boolean instead of throwing, because a flaky
// notification should never roll back a real appointment.

export async function sendBookingConfirmationEmail(
  shop: Shop,
  booking: { customerEmail: string; customerName: string; serviceName: string; startsAt: Date; manageUrl: string },
) {
  if (!shop.resendApiKey || !shop.notifyFromEmail) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${shop.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: shop.notifyFromEmail,
        to: booking.customerEmail,
        subject: `Booking confirmed: ${booking.serviceName}`,
        html: confirmationEmailHtml(booking),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendBookingConfirmationSms(
  shop: Shop,
  booking: { customerPhone: string; serviceName: string; startsAt: Date },
) {
  if (!shop.twilioAccountSid || !shop.twilioAuthToken || !shop.twilioFromNumber) return false;

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${shop.twilioAccountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${shop.twilioAccountSid}:${shop.twilioAuthToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: shop.twilioFromNumber,
          To: booking.customerPhone,
          Body: `Your ${booking.serviceName} appointment is confirmed for ${booking.startsAt.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}.`,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function confirmationEmailHtml(booking: {
  customerName: string;
  serviceName: string;
  startsAt: Date;
  manageUrl: string;
}) {
  const when = booking.startsAt.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `
    <div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto">
      <h2 style="margin:0 0 4px">Booking confirmed</h2>
      <p style="color:#666">Hi ${escapeHtml(booking.customerName)}, you're booked in.</p>
      <div style="background:#f6f5fb;border-radius:12px;padding:16px;margin:16px 0">
        <p style="font-weight:700;margin:0 0 4px">${escapeHtml(booking.serviceName)}</p>
        <p style="color:#5b5bd6;font-weight:600;margin:0">${when}</p>
      </div>
      <a href="${booking.manageUrl}" style="color:#5b5bd6;font-weight:600">Reschedule or cancel this booking</a>
    </div>
  `;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
