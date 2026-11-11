import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { sendBookingReminderEmail, sendBookingReminderSms } from "../models/notify.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

// Hit by an external scheduler (Hostinger Cron Jobs, cron-job.org, etc.)
// on a short interval — e.g. every 15 minutes — since nothing in this
// app's own process can be trusted to stay alive on its own (see the
// README's note on host sleep behavior). Finds confirmed bookings whose
// appointment is 23-25 hours out and hasn't had a reminder sent yet,
// sends one, and marks it so the next run doesn't send it twice.
//
// Authenticated by a shared secret (CRON_SECRET) rather than a Shopify
// session, since the caller is a plain scheduled HTTP hit with no
// merchant or customer behind it.
export async function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handle(request);
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("X-Cron-Secret");

  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() + 23 * 60 * 60_000);
  const windowEnd = new Date(now.getTime() + 25 * 60 * 60_000);

  const bookings = await prisma.booking.findMany({
    where: {
      status: "confirmed",
      reminderSentAt: null,
      startsAt: { gte: windowStart, lte: windowEnd },
    },
    include: { service: true, shop: true },
  });

  let sent = 0;

  for (const booking of bookings) {
    const manageUrl = `${appUrl}/apps/booking/manage?token=${booking.manageToken}`;

    const emailOk = await sendBookingReminderEmail(booking.shop, {
      customerEmail: booking.customerEmail,
      customerName: booking.customerName,
      serviceName: booking.service.name,
      startsAt: booking.startsAt,
      manageUrl,
    });

    let smsOk = false;
    if (booking.smsOptIn && booking.customerPhone) {
      smsOk = await sendBookingReminderSms(booking.shop, {
        customerPhone: booking.customerPhone,
        serviceName: booking.service.name,
        startsAt: booking.startsAt,
      });
    }

    if (emailOk || smsOk) sent += 1;

    // Mark as handled regardless of whether a provider was configured —
    // this booking's reminder window has been processed either way, and
    // retrying it every 15 minutes for the next 2 hours would be noise.
    await prisma.booking.update({
      where: { id: booking.id },
      data: { reminderSentAt: now },
    });
  }

  return json({ checked: bookings.length, sent });
}
