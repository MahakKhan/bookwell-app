import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { loadService } from "../models/booking.server";
import { proxyShop, widgetConfig } from "../models/storefront.server";

// Reached at /apps/booking/config?serviceId=... on the storefront.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });
  const serviceId = new URL(request.url).searchParams.get("serviceId") || "";
  const service = await loadService(shop.id, serviceId);
  if (!service || !service.active || service.archived) return json({ error: "Not found" }, { status: 404 });
  return json(await widgetConfig(shop, service), { headers: { "Cache-Control": "no-store" } });
}
