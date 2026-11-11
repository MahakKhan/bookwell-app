import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Fires whenever a subscription's status changes (active, cancelled,
// frozen, etc). Keeping Shop.planName in sync here — instead of only
// trusting the charge that happened at checkout — is part of the
// billing-integrity fix: the local record never silently drifts from
// what Shopify actually billed.
export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  const subscription = (
    payload as { app_subscription?: { status?: string; name?: string } }
  ).app_subscription;

  await prisma.shop.update({
    where: { shopDomain: shop },
    data: {
      // Store the actual plan name (e.g. "Entry", "Growth") rather than
      // a generic "paid" flag, so the dashboard and gating logic can
      // tell the tiers apart.
      planName:
        subscription?.status === "ACTIVE" ? subscription.name ?? "paid" : "free",
    },
  });

  return new Response();
}
