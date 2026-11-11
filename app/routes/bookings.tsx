import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createBooking, SlotTakenError } from "../models/booking.server";
import { sendBookingConfirmationEmail, sendBookingConfirmationSms } from "../models/notify.server";
import { createGoogleCalendarEvent } from "../models/calendar.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

// Reached at /apps/booking/bookings on the storefront, but Shopify's App
// Proxy strips the "/apps/booking" prefix before forwarding, so this
// route lives at the bare path "/bookings" here. The actual
// double-booking protection lives in createBooking() (a serializable
// transaction plus a unique DB index) — it runs exactly the same way
// here regardless of the shop's plan, because that protection is never
// a paywalled feature in this app.
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unknown shop" }, { status: 401 });

  const body = await request.json();
  const { serviceId, staffId, startsAt, customerName, customerEmail, customerPhone, smsOptIn } = body;

  if (!serviceId || !staffId || !startsAt || !customerName || !customerEmail) {
    return json({ error: "Missing required fields" }, { status: 400 });
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  const staff = await prisma.staffMember.findUnique({ where: { id: staffId } });
  if (!shop || !service || !staff) return json({ error: "Not found" }, { status: 404 });

  try {
    // Must match the effective duration availability.tsx used to generate
    // this slot (service length + buffer), or a booking could land inside
    // what the widget just displayed as someone else's buffer gap.
    const effectiveDuration = service.durationMinutes + service.bufferMinutes;

    const booking = await createBooking({
      shopId: shop.id,
      serviceId,
      staffId,
      startsAt: new Date(startsAt),
      durationMinutes: effectiveDuration,
      customerName,
      customerEmail,
      customerPhone,
      smsOptIn: Boolean(smsOptIn) && shop.smsEnabled,
    });

    // Fire-and-forget: a slow or failing provider must never make the
    // customer think their booking didn't go through — it already has.
    sendBookingConfirmationEmail(shop, {
      customerEmail: booking.customerEmail,
      customerName: booking.customerName,
      serviceName: service.name,
      startsAt: booking.startsAt,
      manageUrl: `${appUrl}/apps/booking/manage?token=${booking.manageToken}`,
    }).catch(() => {});

    if (booking.smsOptIn && booking.customerPhone) {
      sendBookingConfirmationSms(shop, {
        customerPhone: booking.customerPhone,
        serviceName: service.name,
        startsAt: booking.startsAt,
      }).catch(() => {});
    }

    createGoogleCalendarEvent(shop, {
      serviceName: service.name,
      staffName: staff.name,
      customerName: booking.customerName,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    })
      .then((googleEventId) => {
        if (googleEventId) {
          return prisma.booking.update({ where: { id: booking.id }, data: { googleEventId } });
        }
      })
      .catch(() => {});

    return json({ booking });
  } catch (error) {
    if (error instanceof SlotTakenError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
