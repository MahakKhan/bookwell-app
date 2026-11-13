import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { getOpenDays, getOpenSlots, loadService } from "../models/booking.server";
import { proxyShop } from "../models/storefront.server";
import { DATE_RE, addDays } from "../models/time.server";

// Reached at /apps/booking/availability on the storefront (the App Proxy
// strips the prefix). Two modes:
//   ?date=YYYY-MM-DD        → slots for that day
//   ?from=YYYY-MM-DD&to=... → which days have anything open (calendar)
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });

  const url = new URL(request.url);
  const p = (k: string) => url.searchParams.get(k);
  const service = await loadService(shop.id, p("serviceId") || "");
  if (!service || !service.active || service.archived) return json({ error: "Not found" }, { status: 404 });

  const staffId = p("staffId") || "any";
  const quantity = Math.max(1, Math.min(500, Number(p("quantity")) || 1));
  const addonIds = (p("addons") || "").split(",").filter(Boolean);
  const addonMinutes = service.addons.filter((a) => addonIds.includes(a.id)).reduce((n, a) => n + a.durationMinutes, 0);

  // Reschedule: ignore the booking being moved so its own slot shows as free.
  let excludeBookingId: string | undefined;
  const excludeToken = p("excludeToken");
  if (excludeToken) {
    const b = await prisma.booking.findFirst({ where: { manageToken: excludeToken, shopId: shop.id }, select: { id: true } });
    excludeBookingId = b?.id;
  }

  const from = p("from");
  const to = p("to");
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    const end = to > addDays(from, 62) ? addDays(from, 62) : to;
    const days = await getOpenDays({ shop, service, staffId, from, to: end, quantity });
    return json({ days, timezone: shop.timezone });
  }

  const date = p("date");
  if (!date || !DATE_RE.test(date)) {
    return json({ error: "date (YYYY-MM-DD) or from/to is required" }, { status: 400 });
  }
  const slots = await getOpenSlots({ shop, service, staffId, date, quantity, addonMinutes, excludeBookingId });
  return json({
    slots: slots.map((s) => ({ startsAt: s.startsAt, available: s.available, seatsLeft: s.seatsLeft, staffId: s.staffId })),
    timezone: shop.timezone,
  });
}
