import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { proxyShop } from "../models/storefront.server";
import { SubmitError, submitBooking } from "../models/submit.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";

// Reached at /apps/booking/bookings on the storefront (App Proxy strips the
// prefix). Double-booking protection lives in createBooking().
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });

  if (rateLimited(`book:${clientIp(request)}`, 10, 60_000)) {
    return json({ error: "Too many attempts. Please wait a minute and try again." }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const { bookings, checkoutUrl } = await submitBooking(shop, body, "widget", {
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    const first = bookings[0];
    // Return only what the widget needs, never the whole row.
    return json({
      booking: {
        id: first.id,
        startsAt: first.startsAt,
        status: first.status,
        manageToken: first.manageToken,
        count: bookings.length,
        totalPrice: Number(first.totalPrice) * bookings.length,
        amountDue: Number(first.amountDue) * bookings.length,
      },
      checkoutUrl: checkoutUrl ?? null,
    });
  } catch (e) {
    if (e instanceof SubmitError) return json({ error: e.message }, { status: e.status });
    throw e;
  }
}
