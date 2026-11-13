import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";
import { getSlotsRange, loadService } from "../models/booking.server";
import { escapeHtml } from "../models/notify.server";
import { addDays, formatInTz, localParts, zonedToUtc } from "../models/time.server";

// /apps/booking/events on the storefront: a public event calendar listing the
// upcoming sessions of every group class / event / workshop with seats left.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return new Response("Unknown shop", { status: 401 });
  const today = localParts(new Date(), shop.timezone).dateStr;
  const to = addDays(today, 30);

  const services = await prisma.service.findMany({
    where: { shopId: shop.id, active: true, archived: false, OR: [{ type: { in: ["event", "group"] } }, { capacity: { gt: 1 }, type: { notIn: ["fullday", "multiday"] } }] },
    select: { id: true },
  });
  const rows: { date: string; at: Date; name: string; serviceId: string; seats: number; full: boolean }[] = [];
  for (const { id } of services) {
    const service = await loadService(shop.id, id);
    if (!service) continue;
    const days = await getSlotsRange({ shop, service, from: today, to });
    for (const d of days) {
      for (const s of d.slots) rows.push({ date: d.date, at: s.startsAt, name: service.name, serviceId: id, seats: s.seatsLeft, full: !s.available });
    }
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());

  const byDate = new Map<string, typeof rows>();
  for (const r of rows.slice(0, 300)) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const accent = escapeHtml(shop.widgetAccent);
  const html = [...byDate.entries()]
    .map(([date, list]) => {
      const heading = formatInTz(zonedToUtc(date, 720, shop.timezone), shop.timezone, { weekday: "long", month: "long", day: "numeric" });
      const items = list
        .map((r) => {
          const time = formatInTz(r.at, shop.timezone, { hour: "numeric", minute: "2-digit", hour12: !shop.use24h });
          const right = r.full
            ? `<span style="color:#b23a2e;font-weight:600">Full</span>`
            : `<a href="/apps/booking/book?service=${encodeURIComponent(r.serviceId)}&date=${date}" style="background:${accent};color:#fff;padding:7px 14px;border-radius:9px;text-decoration:none;font-weight:600">Book</a>`;
          return `<div style="display:flex;align-items:center;gap:14px;padding:12px 0;border-top:1px solid #eee">
            <b style="min-width:80px">${escapeHtml(time)}</b>
            <div style="flex:1">${escapeHtml(r.name)}${!r.full && r.seats < 1000 ? `<div style="color:#6c6a92;font-size:13px">${r.seats} spot(s) left</div>` : ""}</div>${right}</div>`;
        })
        .join("");
      return `<h3 style="margin:24px 0 4px">${escapeHtml(heading)}</h3>${items}`;
    })
    .join("");

  return new Response(
    `<div class="page-width" style="max-width:820px;margin:0 auto;padding:32px 16px;font-family:Inter,system-ui,sans-serif">` +
      `<h1 style="margin:0 0 6px">Upcoming events</h1><p style="color:#6c6a92;margin:0">Classes, workshops and events in the next 30 days.</p>` +
      (html || `<p style="margin-top:20px">Nothing scheduled right now.</p>`) +
      `</div>`,
    { headers: { "Content-Type": "application/liquid", "Cache-Control": "no-store" } },
  );
}
