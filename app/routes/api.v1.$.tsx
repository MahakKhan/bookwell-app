import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { cancelBookingById, getOpenSlots, isDayService, loadService } from "../models/booking.server";
import { onBookingCancelled, serializeBooking } from "../models/lifecycle.server";
import { SubmitError, submitBooking } from "../models/submit.server";
import { rateLimited } from "../models/ratelimit.server";
import { DATE_RE, addDays, zonedToUtc } from "../models/time.server";

// Public REST API (Integrations → Public API).
//   GET  /api/v1/services
//   GET  /api/v1/availability?serviceId=&date=YYYY-MM-DD[&staffId=&quantity=]
//   GET  /api/v1/bookings[?from=&to=&status=]
//   GET  /api/v1/bookings/:id
//   POST /api/v1/bookings                 (same body as the storefront widget)
//   POST /api/v1/bookings/:id/cancel
// Auth: "Authorization: Bearer bw_..." — only a SHA-256 hash of the key is stored.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const reply = (data: unknown, status = 200) => json(data, { status, headers: CORS });

async function shopFromKey(request: Request) {
  const key = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!key || !key.startsWith("bw_")) return null;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  if (rateLimited(`api:${hash}`, 120, 60_000)) throw reply({ error: "Rate limit exceeded (120 requests/minute)." }, 429);
  return prisma.shop.findUnique({ where: { apiKeyHash: hash } });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const shop = await shopFromKey(request);
  if (!shop) return reply({ error: "Invalid or missing API key." }, 401);
  const parts = (params["*"] || "").split("/").filter(Boolean);
  const url = new URL(request.url);
  const q = (k: string) => url.searchParams.get(k) || "";

  if (parts[0] === "services" && parts.length === 1) {
    const services = await prisma.service.findMany({
      where: { shopId: shop.id, archived: false },
      include: { addons: { where: { active: true } } },
      orderBy: { position: "asc" },
    });
    return reply({
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        active: s.active,
        durationMinutes: isDayService(s) ? null : s.durationMinutes,
        price: Number(s.price),
        currency: shop.currency,
        capacity: s.capacity,
        maxQuantity: s.maxQuantity,
        paymentMode: s.paymentMode,
        addons: s.addons.map((a) => ({ id: a.id, name: a.name, price: Number(a.price), durationMinutes: a.durationMinutes })),
      })),
    });
  }

  if (parts[0] === "availability") {
    const service = await loadService(shop.id, q("serviceId"));
    if (!service) return reply({ error: "Unknown serviceId." }, 404);
    if (!DATE_RE.test(q("date"))) return reply({ error: "date must be YYYY-MM-DD (shop time)." }, 400);
    const slots = await getOpenSlots({ shop, service, staffId: q("staffId") || "any", date: q("date"), quantity: Number(q("quantity")) || 1 });
    return reply({ timezone: shop.timezone, slots });
  }

  if (parts[0] === "bookings") {
    if (parts[1]) {
      const b = await prisma.booking.findFirst({ where: { id: parts[1], shopId: shop.id }, include: { service: true, staff: true } });
      return b ? reply({ booking: serializeBooking(shop, b) }) : reply({ error: "Not found." }, 404);
    }
    const from = DATE_RE.test(q("from")) ? zonedToUtc(q("from"), 0, shop.timezone) : new Date();
    const to = DATE_RE.test(q("to")) ? zonedToUtc(addDays(q("to"), 1), 0, shop.timezone) : new Date(from.getTime() + 30 * 86_400_000);
    const bookings = await prisma.booking.findMany({
      where: { shopId: shop.id, startsAt: { gte: from, lt: to }, ...(q("status") ? { status: q("status") } : {}) },
      include: { service: true, staff: true },
      orderBy: { startsAt: "asc" },
      take: 500,
    });
    return reply({ bookings: bookings.map((b) => serializeBooking(shop, b)) });
  }

  return reply({ error: "Not found." }, 404);
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const shop = await shopFromKey(request);
  if (!shop) return reply({ error: "Invalid or missing API key." }, 401);
  const parts = (params["*"] || "").split("/").filter(Boolean);

  if (parts[0] === "bookings" && parts.length === 1 && request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "Body must be JSON." }, 400);
    }
    try {
      const { bookings, checkoutUrl } = await submitBooking(shop, body, "api");
      const full = await prisma.booking.findMany({ where: { id: { in: bookings.map((b) => b.id) } }, include: { service: true, staff: true } });
      return reply({ bookings: full.map((b) => serializeBooking(shop, b)), checkoutUrl: checkoutUrl ?? null }, 201);
    } catch (e) {
      if (e instanceof SubmitError) return reply({ error: e.message }, e.status);
      throw e;
    }
  }

  if (parts[0] === "bookings" && parts[2] === "cancel" && request.method === "POST") {
    const cancelled = await cancelBookingById(shop.id, parts[1], "admin");
    if (!cancelled) return reply({ error: "Not found or already cancelled." }, 404);
    const { refund } = await onBookingCancelled(shop, parts[1], "admin");
    return reply({ ok: true, refund });
  }

  return reply({ error: "Not found." }, 404);
}
