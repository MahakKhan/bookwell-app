import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { buildIcs } from "../models/ics.server";
import { isDayService } from "../models/booking.server";
import { localParts } from "../models/time.server";
import { addDays } from "../dates";
import { clientIp, rateLimited } from "../models/ratelimit.server";

// Private calendar feed: <app url>/feeds/<token>.ics[?staff=<id>]. Apple
// Calendar (File → New Calendar Subscription), Google and Outlook subscribe to
// it and refresh it on their own. The token is the only credential; the
// merchant can rotate it on the Integrations page.
export async function loader({ params, request }: LoaderFunctionArgs) {
  if (rateLimited(`ics:${clientIp(request)}`, 60, 60_000)) return new Response("Too many requests", { status: 429 });
  const token = (params.file || "").replace(/\.ics$/i, "");
  if (token.length < 20) return new Response("Not found", { status: 404 });
  const shop = await prisma.shop.findUnique({ where: { icsToken: token } });
  if (!shop) return new Response("Not found", { status: 404 });
  const staffId = new URL(request.url).searchParams.get("staff");

  const bookings = await prisma.booking.findMany({
    where: {
      shopId: shop.id,
      status: { in: ["confirmed", "pending", "completed", "cancelled"] },
      startsAt: { gte: new Date(Date.now() - 30 * 86_400_000), lt: new Date(Date.now() + 365 * 86_400_000) },
      ...(staffId ? { staffId } : {}),
    },
    include: { service: { select: { name: true, type: true } }, staff: { select: { name: true } } },
    orderBy: { startsAt: "asc" },
    take: 3000,
  });

  const body = buildIcs(
    `Bookwell · ${shop.shopDomain.replace(".myshopify.com", "")}`,
    bookings.map((b) => {
      const day = isDayService(b.service);
      const start = localParts(b.startsAt, shop.timezone).dateStr;
      const lastDay = localParts(new Date(b.endsAt.getTime() - 1), shop.timezone).dateStr;
      return {
        uid: b.id,
        title: `${b.service.name} — ${b.customerName}${b.quantity > 1 ? ` (${b.quantity})` : ""}`,
        description: [
          b.staff ? `With ${b.staff.name}` : null,
          `${b.customerEmail}${b.customerPhone ? ` · ${b.customerPhone}` : ""}`,
          b.status === "pending" ? "Awaiting payment" : null,
          b.meetingUrl ? `Meeting: ${b.meetingUrl}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: b.meetingUrl ?? undefined,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        allDay: day ? { startDate: start, endDateExclusive: addDays(lastDay, 1) } : undefined,
        cancelled: b.status === "cancelled",
        updatedAt: b.updatedAt,
      };
    }),
  );
  return new Response(body, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300", "Content-Disposition": 'inline; filename="bookwell.ics"' },
  });
}
