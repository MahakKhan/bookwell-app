import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { invalidateShop } from "../models/shop.server";

// Fires whenever a subscription's status changes. Keeps Shop.planName in
// sync with what Shopify actually billed, so the local record can't drift.
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const subscription = (payload as { app_subscription?: { status?: string; name?: string; created_at?: string } })
    .app_subscription;
  const active = subscription?.status === "ACTIVE";

  // updateMany (not update): the shop row may not exist yet if the merchant
  // never opened the app, and a throw here makes Shopify retry forever.
  await prisma.shop.updateMany({
    where: { shopDomain: shop },
    data: {
      planName: active ? (subscription?.name ?? "Starter") : "free",
      planStartedAt: active && subscription?.created_at ? new Date(subscription.created_at) : null,
      ...(active ? { trialUsed: true } : {}),
    },
  });

  invalidateShop(shop);
  return new Response();
}
