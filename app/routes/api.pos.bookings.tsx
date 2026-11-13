import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { localParts, zonedToUtc, addDays } from "../models/time.server";

// Called by the POS extension over a bearer session token. Returns the rest
// of today's bookings (today in the STORE's timezone) — the same Booking rows
// the storefront widget books into — and lets staff check guests in.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, cors } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return cors(json({ bookings: [] }));

  const now = new Date();
  const today = localParts(now, shop.timezone).dateStr;
  const dayStart = zonedToUtc(today, 0, shop.timezone);
  const dayEnd = zonedToUtc(addDays(today, 1), 0, shop.timezone);

  const bookings = await prisma.booking.findMany({
    where: {
      shopId: shop.id,
      status: { in: ["confirmed", "completed"] },
      startsAt: { gte: dayStart, lt: dayEnd },
      endsAt: { gt: now },
    },
    include: { service: true, staff: true },
    orderBy: { startsAt: "asc" },
    take: 50,
  });

  return cors(
    json({
      timezone: shop.timezone,
      bookings: bookings.map((b) => ({
        id: b.id,
        startsAt: b.startsAt,
        serviceName: b.service.name,
        staffName: b.staff?.name ?? "",
        customerName: b.customerName,
        quantity: b.quantity,
        checkedIn: Boolean(b.checkedInAt),
      })),
    }),
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, cors } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return cors(json({ error: "Unknown shop" }, { status: 404 }));
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // empty
  }
  if (body.intent === "checkin") {
    const r = await prisma.booking.updateMany({
      where: { id: String(body.id || ""), shopId: shop.id, status: { in: ["confirmed", "completed"] }, checkedInAt: null },
      data: { checkedInAt: new Date(), status: "completed" },
    });
    return cors(json({ ok: r.count > 0 }));
  }
  return cors(json({ error: "Unknown action" }, { status: 400 }));
}
