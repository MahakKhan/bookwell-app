import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { proxyShop } from "../models/storefront.server";

// Legacy endpoint (older widget builds): /apps/booking/staff. New widgets use
// /apps/booking/config, which also returns the service's own team members.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await proxyShop(request);
  if (!shop) return json({ error: "Unknown shop" }, { status: 401 });
  const staff = await prisma.staffMember.findMany({
    where: { shopId: shop.id, active: true },
    select: { id: true, name: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return json({ staff, timezone: shop.timezone });
}
