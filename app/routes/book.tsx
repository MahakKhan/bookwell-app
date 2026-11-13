import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";
import { escapeHtml } from "../models/notify.server";

// /apps/booking/book on the storefront: the "services list page" plus a
// standalone booking page per service (?service=<id>). Returned as Liquid so
// Shopify renders it inside the store's own theme (header, footer, fonts).
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return new Response("Unknown shop", { status: 401 });
  const url = new URL(request.url);
  const serviceId = url.searchParams.get("service");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date")! : "";
  const assets =
    `<link rel="stylesheet" href="/apps/booking/widget.css">` +
    `<script src="/apps/booking/widget.js" defer></script>`;
  const wrap = (inner: string, title: string) =>
    new Response(
      `{% layout 'theme' %}<div class="page-width" style="max-width:960px;margin:0 auto;padding:32px 16px;--bw-accent:${escapeHtml(shop.widgetAccent)}">` +
        `<h1 style="margin:0 0 8px">${escapeHtml(title)}</h1>${inner}</div>${assets}`,
      { headers: { "Content-Type": "application/liquid", "Cache-Control": "no-store" } },
    );

  if (serviceId) {
    const service = await prisma.service.findFirst({
      where: { id: serviceId, shopId: shop.id, active: true, archived: false },
      select: { id: true, name: true },
    });
    if (!service) return wrap(`<p>This service isn't available.</p><p><a href="/apps/booking/book">See all services</a></p>`, "Book");
    return wrap(
      `<p><a href="/apps/booking/book">&larr; All services</a></p>` +
        `<div class="bookwell-widget" data-service-id="${escapeHtml(service.id)}" data-open="true"${date ? ` data-date="${date}"` : ""} data-lang="{{ request.locale.iso_code }}"></div>`,
      service.name,
    );
  }

  const services = await prisma.service.findMany({
    where: { shopId: shop.id, active: true, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, description: true, price: true, durationMinutes: true, type: true },
  });
  const cards = services
    .map((s) => {
      const day = s.type === "fullday" || s.type === "multiday";
      const meta = [day ? null : `${s.durationMinutes} min`, Number(s.price) > 0 ? `${Number(s.price).toFixed(2)} ${shop.currency}` : "Free"].filter(Boolean).join(" · ");
      return (
        `<a href="/apps/booking/book?service=${encodeURIComponent(s.id)}"><h3>${escapeHtml(s.name)}</h3>` +
        `<p>${escapeHtml(meta)}</p>${s.description ? `<p style="margin-top:6px">${escapeHtml(s.description.slice(0, 160))}</p>` : ""}</a>`
      );
    })
    .join("");
  return wrap(services.length ? `<div class="bookwell-list">${cards}</div>` : `<p>No services are open for booking yet.</p>`, "Book an appointment");
}
