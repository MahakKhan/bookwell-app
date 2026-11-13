import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";
import { EMAIL_RE } from "../models/submit.server";
import { clientIp, rateLimited } from "../models/ratelimit.server";
import { DATE_RE } from "../models/time.server";

// /apps/booking/waitlist — join the waitlist for a full slot or day. When a
// matching booking is cancelled, lifecycle.server.ts emails the people waiting.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });
  if (rateLimited(`wait:${clientIp(request)}`, 10, 60_000)) {
    return json({ error: "Too many attempts. Please wait a minute." }, { status: 429 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, { status: 400 });
  }
  const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
  const date = str(body.date, 10);
  const customerName = str(body.customerName, 120);
  const customerEmail = str(body.customerEmail, 200).toLowerCase();
  if (!DATE_RE.test(date) || !customerName || !EMAIL_RE.test(customerEmail)) {
    return json({ error: "Name, a valid email and a date are required." }, { status: 400 });
  }

  const service = await prisma.service.findFirst({
    where: { id: str(body.serviceId, 64), shopId: shop.id, active: true, waitlistEnabled: true },
    select: { id: true },
  });
  if (!service) return json({ error: "The waitlist isn't available for this service." }, { status: 404 });

  const startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
  const existing = await prisma.waitlistEntry.findFirst({
    where: { shopId: shop.id, serviceId: service.id, date, customerEmail, status: "waiting" },
    select: { id: true },
  });
  if (!existing) {
    await prisma.waitlistEntry.create({
      data: {
        shopId: shop.id,
        serviceId: service.id,
        staffId: body.staffId && body.staffId !== "any" ? str(body.staffId, 64) : null,
        date,
        startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
        customerName,
        customerEmail,
        customerPhone: str(body.customerPhone, 40) || null,
      },
    });
  }
  return json({ ok: true });
}
