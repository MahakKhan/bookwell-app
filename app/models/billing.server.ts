import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { CYCLE_DAYS, GRACE, TRIAL_DAYS, parsePlan, seatsAllowed, subscriptionName, subscriptionPrice, type Plan } from "../plans";
import { invalidateShop } from "./shop.server";
import { sendEmail } from "./notify.server";

type Admin = { graphql: (q: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response> };

export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
  createdAt: string;
  currentPeriodEnd: string | null;
  trialDays: number;
};

export async function getActiveSubscription(admin: Admin): Promise<ActiveSubscription | null> {
  const res = await admin.graphql(`#graphql
    query BookwellSubs {
      currentAppInstallation {
        activeSubscriptions { id name status test createdAt currentPeriodEnd trialDays }
      }
    }`);
  const data = await res.json();
  const subs = (data?.data?.currentAppInstallation?.activeSubscriptions ?? []) as ActiveSubscription[];
  return subs.find((s) => s.status === "ACTIVE") ?? null;
}

/** Makes the local plan match what Shopify actually bills. Returns the fresh shop. */
export async function syncPlanFromShopify(admin: Admin, shop: Shop) {
  const sub = await getActiveSubscription(admin);
  const planName = sub ? sub.name : "free";
  const startedAt = sub ? new Date(sub.createdAt) : null;
  const changed = shop.planName !== planName || (startedAt?.getTime() ?? null) !== (shop.planStartedAt?.getTime() ?? null);
  if (!changed) return { shop, sub };
  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: { planName, planStartedAt: startedAt, ...(sub ? { trialUsed: true } : {}) },
  });
  invalidateShop(shop.shopDomain);
  return { shop: updated, sub };
}

/**
 * Starts Shopify's approval flow for a plan (+ extra seats). Returns the URL
 * the merchant must open to approve the charge. Replaces any current plan.
 */
export async function createSubscription(admin: Admin, shop: Shop, plan: Plan, extraSeats: number, returnUrl: string, test: boolean) {
  const amount = subscriptionPrice(plan, extraSeats);
  const res = await admin.graphql(
    `#graphql
    mutation BookwellSubscribe($name: String!, $returnUrl: URL!, $test: Boolean, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, trialDays: $trialDays, lineItems: $lineItems, replacementBehavior: APPLY_IMMEDIATELY) {
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: subscriptionName(plan, extraSeats),
        returnUrl,
        test,
        trialDays: shop.trialUsed ? 0 : TRIAL_DAYS,
        lineItems: [
          { plan: { appRecurringPricingDetails: { price: { amount: amount.toFixed(2), currencyCode: "USD" }, interval: "EVERY_30_DAYS" } } },
        ],
      },
    },
  );
  const data = await res.json();
  const err = data?.data?.appSubscriptionCreate?.userErrors?.[0]?.message || data?.errors?.[0]?.message;
  const url = data?.data?.appSubscriptionCreate?.confirmationUrl as string | undefined;
  if (!url) throw new Error(err || "Shopify didn't return a confirmation page.");
  return url;
}

export async function cancelSubscription(admin: Admin, id: string) {
  const res = await admin.graphql(
    `#graphql
    mutation BookwellCancelSub($id: ID!) { appSubscriptionCancel(id: $id, prorate: true) { userErrors { message } } }`,
    { variables: { id } },
  );
  const data = await res.json();
  const err = data?.data?.appSubscriptionCancel?.userErrors?.[0]?.message;
  if (err) throw new Error(err);
}

// ---------------------------------------------------------------------------
// Usage: bookings per 30-day cycle
// ---------------------------------------------------------------------------

export function cycleFor(shop: Pick<Shop, "planStartedAt" | "createdAt">, now = new Date()) {
  const anchor = (shop.planStartedAt ?? shop.createdAt).getTime();
  const len = CYCLE_DAYS * 86_400_000;
  const n = Math.max(0, Math.floor((now.getTime() - anchor) / len));
  const start = new Date(anchor + n * len);
  return { start, end: new Date(start.getTime() + len), key: start.toISOString().slice(0, 10) };
}

/**
 * Counts what the plan limit applies to: bookings customers made (online,
 * POS, API, team portal) this cycle that weren't cancelled or abandoned.
 * Bookings the merchant enters by hand are never counted.
 */
export async function usageFor(shop: Shop) {
  const { plan, extraSeats } = parsePlan(shop.planName);
  const cycle = cycleFor(shop);
  const [used, seatsUsed] = await Promise.all([
    prisma.booking.count({
      where: {
        shopId: shop.id,
        createdAt: { gte: cycle.start },
        source: { not: "manual" },
        status: { notIn: ["cancelled", "abandoned"] },
      },
    }),
    prisma.staffMember.count({ where: { shopId: shop.id, active: true } }),
  ]);
  return {
    plan,
    extraSeats,
    used,
    limit: plan.bookings,
    hardLimit: plan.bookings === null ? null : Math.ceil(plan.bookings * GRACE),
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    cycleKey: cycle.key,
    seatsUsed,
    seatsAllowed: seatsAllowed(shop.planName),
  };
}

/**
 * Called before every customer-made booking. Over the plan limit, bookings
 * keep working up to the grace margin (and the merchant is emailed once);
 * past it, online booking pauses until the merchant upgrades or the cycle
 * resets.
 */
export async function assertCanTakeBooking(shop: Shop, count = 1) {
  const u = await usageFor(shop);
  if (u.limit === null) return u;
  if (u.used + count > u.limit && shop.usageAlertCycle !== u.cycleKey) {
    await prisma.shop.update({ where: { id: shop.id }, data: { usageAlertCycle: u.cycleKey } });
    invalidateShop(shop.shopDomain);
    if (shop.notifyMerchantEmail) {
      void sendEmail(
        shop,
        shop.notifyMerchantEmail,
        "Bookwell: you've reached your plan's booking limit",
        `<p>Your ${u.plan.name} plan includes ${u.limit} bookings per 30 days and you've used ${u.used}.</p>
         <p>Online bookings keep working up to ${u.hardLimit}, then pause until ${u.cycleEnd.toDateString()}. Upgrade in Bookwell → Billing to keep taking bookings.</p>`,
        "merchant",
      ).catch(() => {});
    }
  }
  if (u.hardLimit !== null && u.used + count > u.hardLimit) {
    throw new Error("PLAN_LIMIT");
  }
  return u;
}

// ---------------------------------------------------------------------------
// Weekly reconciliation (see jobs.server.ts)
// ---------------------------------------------------------------------------

/**
 * For every shop on a paid plan, asks Shopify for the real subscription and
 * logs whether it matches — so a billing gap gets caught in days, not years.
 * Also re-syncs the local plan name from Shopify.
 */
export async function reconcileShopBilling(shopDomain: string) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop || shop.planName === "free") return null;
  const { admin } = await unauthenticated.admin(shopDomain);
  const sub = await getActiveSubscription(admin);
  const confirmedCharges = sub ? 1 : 0;
  const mismatches = sub && sub.name === shop.planName ? 0 : 1;
  await syncPlanFromShopify(admin, shop);
  return prisma.billingReconciliation.create({
    data: {
      shopId: shop.id,
      expectedCharges: 1,
      confirmedCharges,
      mismatches,
      details: mismatches ? JSON.stringify({ expected: shop.planName, actual: sub?.name ?? null }) : null,
    },
  });
}
