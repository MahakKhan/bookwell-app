import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Called by the POS Smart Grid extension (extensions/bookwell-pos) over
// a bearer session token, not a browser cookie session — authenticate.admin
// handles both the same way. Returns today's remaining bookings so staff
// on the shop floor see the exact same availability data the storefront
// widget and admin calendar already share (see booking.server.ts).
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return cors(json({ bookings: [] }));

  const now = new Date();
  const dayEnd = new Date(now);
  dayEnd.setHours(23, 59, 59, 999);

  const bookings = await prisma.booking.findMany({
    where: {
      shopId: shop.id,
      status: "confirmed",
      startsAt: { gte: now, lte: dayEnd },
    },
    include: { service: true, staff: true },
    orderBy: { startsAt: "asc" },
    take: 25,
  });

  return cors(
    json({
      bookings: bookings.map((b) => ({
        id: b.id,
        startsAt: b.startsAt,
        serviceName: b.service.name,
        staffName: b.staff.name,
        customerName: b.customerName,
      })),
    }),
  );
}

export async function action({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  return cors(json({ error: "Method not allowed" }, { status: 405 }));
}

function cors<T extends Response>(response: T): T {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  return response;
}
