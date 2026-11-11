import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

/**
 * Weekly job (wire to a scheduled task / cron trigger in production):
 * for every shop on a paid plan, ask Shopify for the real subscription
 * status and compare it to what we expect, then log the result.
 *
 * This exists because Appointo — one of the four competitors this app
 * was scoped against — had recurring membership charges silently stop
 * firing for up to two years on some stores. A merchant's trust in a
 * booking app is a bet that its billing is correct; this job makes
 * that bet auditable instead of assumed.
 */
export async function reconcileShopBilling(shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop || shop.planName === "free") return null;

  const { admin } = await unauthenticated.admin(shopDomain);

  const response = await admin.graphql(`
    query ActiveSubscriptions {
      currentAppInstallation {
        activeSubscriptions {
          id
          status
          currentPeriodEnd
        }
      }
    }
  `);
  const data = await response.json();
  const subs = data.data?.currentAppInstallation?.activeSubscriptions ?? [];

  const expectedCharges = 1; // one active subscription per paid shop
  const confirmedCharges = subs.filter(
    (s: { status: string }) => s.status === "ACTIVE",
  ).length;
  const mismatches = Math.abs(expectedCharges - confirmedCharges);

  const log = await prisma.billingReconciliation.create({
    data: {
      shopId: shop.id,
      expectedCharges,
      confirmedCharges,
      mismatches,
      details: mismatches > 0 ? JSON.stringify(subs) : null,
    },
  });

  // TODO: if mismatches > 0, alert the merchant + an internal channel
  // instead of only logging it, so a billing gap gets caught in days,
  // not years.
  return log;
}
