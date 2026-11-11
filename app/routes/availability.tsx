import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOpenSlots } from "../models/booking.server";

// Reached at /apps/booking/availability on the storefront, but Shopify's
// App Proxy strips the "/apps/booking" prefix before forwarding, so this
// route lives at the bare path "/availability" here. This is the exact
// function the admin dashboard calendar also reads from (see
// routes/app._index.tsx and models/booking.server.ts) — one source of
// truth for availability instead of the storefront and POS drifting
// apart, which is the bug that caused overbooking on one of the four
// competitor apps this project is scoped against.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unknown shop" }, { status: 401 });

  const url = new URL(request.url);
  const serviceId = url.searchParams.get("serviceId");
  const staffId = url.searchParams.get("staffId");
  const dateParam = url.searchParams.get("date");

  if (!serviceId || !staffId || !dateParam) {
    return json({ error: "serviceId, staffId and date are required" }, { status: 400 });
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!shop || !service) return json({ error: "Not found" }, { status: 404 });

  // Block out the buffer time after each appointment by folding it into
  // the slot's effective length, so a 15-min service with a 5-min buffer
  // offers slots 20 minutes apart instead of the old fixed 30-min grid
  // (which also silently ignored bufferMinutes entirely).
  const effectiveDuration = service.durationMinutes + service.bufferMinutes;

  const slots = await getOpenSlots({
    shopId: shop.id,
    serviceId,
    staffId,
    date: new Date(dateParam),
    durationMinutes: effectiveDuration,
    slotStepMinutes: effectiveDuration,
  });

  return json({ slots });
}
