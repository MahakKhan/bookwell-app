import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Reached at /apps/booking/staff on the storefront (Shopify's App Proxy
// strips the "/apps/booking" prefix, so this route lives at the bare
// path "/staff" here — same reasoning as availability.tsx and
// bookings.tsx). Lets the widget show a real staff picker instead of
// the "default" placeholder staffId it used before.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unknown shop" }, { status: 401 });

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ error: "Not found" }, { status: 404 });

  const staff = await prisma.staffMember.findMany({
    where: { shopId: shop.id, active: true },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  return json({ staff });
}
