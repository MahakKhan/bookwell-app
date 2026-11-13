import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getShop } from "../models/shop.server";
import { eligibleStaff, getOpenSlots, isDayService, loadService } from "../models/booking.server";
import { DATE_RE, formatInTz } from "../models/time.server";

// Admin-side slot lookup for manual bookings and reschedules.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await getShop(session.shop);
  const url = new URL(request.url);
  const p = (k: string) => url.searchParams.get(k) || "";

  const service = await loadService(shop.id, p("serviceId"));
  if (!service) return json({ service: null, staff: [], slots: [] });
  const staff = service.staffMode === "staff" ? await eligibleStaff(shop.id, service) : [];
  const date = p("date");
  const slots = DATE_RE.test(date)
    ? await getOpenSlots({
        shop,
        service,
        staffId: p("staffId") || "any",
        date,
        quantity: Math.max(1, Number(p("quantity")) || 1),
        excludeBookingId: p("excludeBookingId") || undefined,
      })
    : [];

  return json({
    service: {
      id: service.id,
      type: service.type,
      dayBased: isDayService(service),
      noStaff: service.staffMode === "staff" && staff.length === 0,
      capacity: service.resource ? service.resource.quantity : service.capacity,
      maxQuantity: service.maxQuantity,
      allowRecurring: service.allowRecurring,
      addons: service.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price) })),
    },
    staff: staff.map((s) => ({ id: s.id, name: s.name })),
    slots: slots.map((s) => ({
      startsAt: s.startsAt.toISOString(),
      label: isDayService(service)
        ? "All day"
        : formatInTz(s.startsAt, shop.timezone, { hour: "numeric", minute: "2-digit", hour12: !shop.use24h }),
      available: s.available,
      seatsLeft: s.seatsLeft,
      staffId: s.staffId,
    })),
  });
}
