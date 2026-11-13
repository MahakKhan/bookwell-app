import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { buildIcs } from "../models/ics.server";
import { isDayService, manageUrlFor } from "../models/booking.server";
import { localParts } from "../models/time.server";
import { addDays } from "../dates";

// "Add to calendar" for one booking: /apps/booking/ics?token=<manage token>
// (via the store's app proxy, linked from emails and the manage page). Works
// with Apple Calendar, Google Calendar, Outlook and any calendar app.
export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[a-z0-9]{16,40}$/i.test(token)) return new Response("Not found", { status: 404 });
  const b = await prisma.booking.findUnique({
    where: { manageToken: token },
    include: { service: { select: { name: true, type: true } }, staff: { select: { name: true } }, shop: true },
  });
  if (!b) return new Response("Not found", { status: 404 });
  const day = isDayService(b.service);
  const start = localParts(b.startsAt, b.shop.timezone).dateStr;
  const lastDay = localParts(new Date(b.endsAt.getTime() - 1), b.shop.timezone).dateStr;
  const body = buildIcs(b.service.name, [
    {
      uid: b.id,
      title: b.service.name,
      description: [b.staff ? `With ${b.staff.name}` : null, b.meetingUrl ? `Join: ${b.meetingUrl}` : null, `Manage: ${manageUrlFor(b.shop.shopDomain, b.manageToken)}`]
        .filter(Boolean)
        .join("\n"),
      url: b.meetingUrl ?? manageUrlFor(b.shop.shopDomain, b.manageToken),
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      allDay: day ? { startDate: start, endDateExclusive: addDays(lastDay, 1) } : undefined,
      cancelled: b.status === "cancelled",
    },
  ]);
  return new Response(body, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="booking.ics"` },
  });
}
