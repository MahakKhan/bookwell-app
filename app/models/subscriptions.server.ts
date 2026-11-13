import type { CustomerPackage, Package, Shop } from "@prisma/client";
import prisma from "../db.server";
import { shopGraphql } from "./lifecycle.server";
import { upsertCustomer } from "./booking.server";
import { escapeHtml, sendEmail } from "./notify.server";

// Auto-renewing memberships and class packs, built on Shopify subscriptions:
//  1. The merchant links a product to a recurring package; we attach a
//     selling plan ("every 1 month") to it.
//  2. A customer subscribes through Shopify checkout → Shopify creates a
//     subscription contract (payment method vaulted by Shopify).
//  3. syncSubscriptionContracts() turns each contract into an active
//     CustomerPackage; runRenewals() bills each renewal on its date with
//     subscriptionBillingAttemptCreate, refills the sessions and moves the
//     next billing date. Failed payments retry daily, up to 3 times.
//
// Needs the read/write_own_subscription_contracts scopes, a payment provider
// that supports subscriptions (Shopify Payments; test mode on dev stores),
// and Protected Customer Data access (name + email) for contract customers.

const GRACE_DAYS = 3;
const MAX_FAILURES = 3;
type Gql = Record<string, any>;

function firstError(data: Gql, key: string) {
  return data?.errors?.[0]?.message || data?.data?.[key]?.userErrors?.[0]?.message || null;
}

export function addInterval(date: Date, interval: string, count: number) {
  const d = new Date(date);
  if (interval === "WEEK") d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (interval === "YEAR") d.setUTCFullYear(d.getUTCFullYear() + count);
  else d.setUTCMonth(d.getUTCMonth() + count);
  return d;
}

export function intervalLabel(interval: string, count: number) {
  const unit = interval === "WEEK" ? "week" : interval === "YEAR" ? "year" : "month";
  return count === 1 ? `every ${unit}` : `every ${count} ${unit}s`;
}

/** Product title/handle/first variant for the packages pages. */
export async function productInfo(shopDomain: string, productId: string) {
  const data = await shopGraphql(
    shopDomain,
    `#graphql
    query BookwellProduct($id: ID!) { product(id: $id) { title handle status variants(first: 1) { nodes { id price } } } }`,
    { id: productId },
  );
  const p = data?.data?.product;
  if (!p) return null;
  return { title: p.title as string, handle: p.handle as string, status: p.status as string, variantId: p.variants?.nodes?.[0]?.id as string | undefined, price: Number(p.variants?.nodes?.[0]?.price ?? 0) };
}

/** Creates (or re-creates) the selling plan for a recurring package. */
export async function ensureSellingPlan(shop: Shop, pkg: Package) {
  if (pkg.sellingPlanGroupId) await removeSellingPlan(shop, pkg);
  if (!pkg.recurring || !pkg.productId) return pkg;
  const info = await productInfo(shop.shopDomain, pkg.productId);
  if (!info?.variantId) throw new Error("The linked product has no variant.");

  const label = intervalLabel(pkg.billingInterval, pkg.billingIntervalCount);
  const policy = { recurring: { interval: pkg.billingInterval, intervalCount: pkg.billingIntervalCount } };
  const data = await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellPlan($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
      sellingPlanGroupCreate(input: $input, resources: $resources) {
        sellingPlanGroup { id sellingPlans(first: 1) { nodes { id } } }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: pkg.name.slice(0, 255),
        merchantCode: `bookwell-${pkg.id}`,
        options: ["Billing"],
        sellingPlansToCreate: [
          {
            name: `${pkg.name} (renews ${label})`.slice(0, 255),
            options: [label],
            category: "SUBSCRIPTION",
            billingPolicy: policy,
            deliveryPolicy: policy,
          },
        ],
      },
      resources: { productIds: [pkg.productId] },
    },
  );
  const group = data?.data?.sellingPlanGroupCreate?.sellingPlanGroup;
  if (!group) throw new Error(firstError(data, "sellingPlanGroupCreate") || "Shopify couldn't create the subscription plan.");
  return prisma.package.update({
    where: { id: pkg.id },
    data: { sellingPlanGroupId: group.id, sellingPlanId: group.sellingPlans?.nodes?.[0]?.id ?? null, variantId: info.variantId, price: info.price },
  });
}

export async function removeSellingPlan(shop: Shop, pkg: Package) {
  if (!pkg.sellingPlanGroupId) return;
  // Existing subscribers keep their contracts; only new sign-ups stop.
  await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellPlanDelete($id: ID!) { sellingPlanGroupDelete(id: $id) { deletedSellingPlanGroupId userErrors { message } } }`,
    { id: pkg.sellingPlanGroupId },
  ).catch(() => null);
  await prisma.package.update({ where: { id: pkg.id }, data: { sellingPlanGroupId: null, sellingPlanId: null } });
}

function manageLink(shopDomain: string, token: string) {
  return `https://${shopDomain}/apps/booking/membership?token=${encodeURIComponent(token)}`;
}

/** Contracts → CustomerPackages (new subscribers, cancellations, pauses). */
export async function syncSubscriptionContracts(shop: Shop) {
  const packages = await prisma.package.findMany({ where: { shopId: shop.id, sellingPlanId: { not: null } } });
  if (!packages.length) return 0;
  const byPlan = new Map(packages.map((p) => [p.sellingPlanId!, p]));

  let after: string | null = null;
  let seen = 0;
  for (let page = 0; page < 10; page++) {
    const data: Gql = await shopGraphql(
      shop.shopDomain,
      `#graphql
      query BookwellContracts($after: String) {
        subscriptionContracts(first: 50, after: $after, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id status nextBillingDate
            customer { email firstName lastName }
            lines(first: 5) { nodes { sellingPlanId } }
          }
        }
      }`,
      { after },
    );
    if (data?.errors?.length) {
      console.error("[bookwell] subscription contracts:", data.errors[0]?.message);
      return seen;
    }
    const conn = data?.data?.subscriptionContracts;
    for (const c of conn?.nodes ?? []) {
      const pkg = (c.lines?.nodes ?? []).map((l: { sellingPlanId?: string }) => byPlan.get(l.sellingPlanId ?? "")).find(Boolean) as Package | undefined;
      if (!pkg) continue;
      seen++;
      await applyContract(shop, pkg, c);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return seen;
}

async function applyContract(
  shop: Shop,
  pkg: Package,
  c: { id: string; status: string; nextBillingDate: string | null; customer: { email: string | null; firstName: string | null; lastName: string | null } | null },
) {
  const existing = await prisma.customerPackage.findUnique({ where: { subscriptionContractId: c.id } });
  const next = c.nextBillingDate ? new Date(c.nextBillingDate) : null;
  const statusMap: Record<string, string> = { ACTIVE: "active", PAUSED: "paused", CANCELLED: "cancelled", EXPIRED: "expired", FAILED: "past_due", STALE: "past_due" };
  const status = statusMap[c.status] ?? "cancelled";

  if (existing) {
    // Don't resurrect a membership we marked past_due, and don't override our own renewal bookkeeping.
    if (existing.status !== status && !(existing.status === "past_due" && status === "active")) {
      await prisma.customerPackage.update({ where: { id: existing.id }, data: { status, ...(status !== "active" ? { expiresAt: new Date() } : {}) } });
    }
    return;
  }
  if (status !== "active") return;
  const email = c.customer?.email?.trim().toLowerCase();
  if (!email) {
    console.error("[bookwell] subscription contract without customer email (needs Protected Customer Data access):", c.id);
    return;
  }
  const name = [c.customer?.firstName, c.customer?.lastName].filter(Boolean).join(" ") || email;
  const customer = await upsertCustomer(shop.id, { name, email });
  const nextBilling = next ?? addInterval(new Date(), pkg.billingInterval, pkg.billingIntervalCount);
  const cp = await prisma.customerPackage.create({
    data: {
      shopId: shop.id,
      packageId: pkg.id,
      customerId: customer.id,
      customerEmail: email,
      customerName: name,
      source: "subscription",
      status: "active",
      creditsLeft: pkg.kind === "membership" ? null : Math.max(1, pkg.credits ?? 1),
      subscriptionContractId: c.id,
      nextBillingDate: nextBilling,
      expiresAt: new Date(nextBilling.getTime() + GRACE_DAYS * 86_400_000),
    },
  });
  void sendEmail(
    shop,
    email,
    `Your ${pkg.name} is active`,
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:0 auto">
      <h2>Welcome, ${escapeHtml(name)}</h2>
      <p>Your <b>${escapeHtml(pkg.name)}</b> is active and renews ${escapeHtml(intervalLabel(pkg.billingInterval, pkg.billingIntervalCount))}.
      ${pkg.kind === "membership" ? "Book as often as you like" : `You have ${pkg.credits} sessions each period`}: just tick "Use my package or membership" when you book with this email.</p>
      <p><a href="${escapeHtml(manageLink(shop.shopDomain, cp.manageToken))}">Manage or cancel your subscription</a></p>
    </div>`,
    "confirmation",
  ).catch(() => {});
}

/** Bills renewals that are due and finishes the ones in progress. */
export async function runRenewals(shop: Shop) {
  const due = await prisma.customerPackage.findMany({
    where: { shopId: shop.id, status: "active", subscriptionContractId: { not: null }, nextBillingDate: { lte: new Date() } },
    include: { package: true },
    take: 100,
  });
  for (const cp of due) {
    try {
      if (cp.billingAttemptId) await checkAttempt(shop, cp);
      else await startAttempt(shop, cp);
    } catch (e) {
      console.error("[bookwell] renewal", cp.id, e);
    }
  }
}

async function startAttempt(shop: Shop, cp: CustomerPackage) {
  // After a failure, wait a day between retries.
  if (cp.billingFailures > 0 && Date.now() - cp.nextBillingDate!.getTime() < cp.billingFailures * 86_400_000) return;
  const data = await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellBill($id: ID!, $input: SubscriptionBillingAttemptInput!) {
      subscriptionBillingAttemptCreate(subscriptionContractId: $id, subscriptionBillingAttemptInput: $input) {
        subscriptionBillingAttempt { id ready errorMessage order { id } }
        userErrors { field message }
      }
    }`,
    {
      id: cp.subscriptionContractId,
      input: { idempotencyKey: `${cp.id}:${cp.nextBillingDate!.toISOString()}:${cp.billingFailures}`, originTime: cp.nextBillingDate!.toISOString() },
    },
  );
  const attempt = data?.data?.subscriptionBillingAttemptCreate?.subscriptionBillingAttempt;
  if (!attempt) throw new Error(firstError(data, "subscriptionBillingAttemptCreate") || "Billing attempt failed to start");
  await prisma.customerPackage.update({ where: { id: cp.id }, data: { billingAttemptId: attempt.id } });
}

async function checkAttempt(shop: Shop, cp: CustomerPackage & { package: Package }) {
  const data = await shopGraphql(
    shop.shopDomain,
    `#graphql
    query BookwellAttempt($id: ID!) { subscriptionBillingAttempt(id: $id) { ready errorMessage order { id } } }`,
    { id: cp.billingAttemptId },
  );
  const a = data?.data?.subscriptionBillingAttempt;
  if (!a || !a.ready) return;

  if (a.order?.id) {
    const next = addInterval(cp.nextBillingDate!, cp.package.billingInterval, cp.package.billingIntervalCount);
    await shopGraphql(
      shop.shopDomain,
      `#graphql
      mutation BookwellNext($id: ID!, $date: DateTime!) {
        subscriptionContractSetNextBillingDate(contractId: $id, date: $date) { contract { id } userErrors { message } }
      }`,
      { id: cp.subscriptionContractId, date: next.toISOString() },
    );
    await prisma.customerPackage.update({
      where: { id: cp.id },
      data: {
        nextBillingDate: next,
        expiresAt: new Date(next.getTime() + GRACE_DAYS * 86_400_000),
        creditsLeft: cp.package.kind === "membership" ? null : Math.max(1, cp.package.credits ?? 1),
        billingAttemptId: null,
        billingFailures: 0,
        shopifyOrderId: a.order.id,
      },
    });
    return;
  }

  const failures = cp.billingFailures + 1;
  const giveUp = failures >= MAX_FAILURES;
  await prisma.customerPackage.update({
    where: { id: cp.id },
    data: { billingAttemptId: null, billingFailures: failures, ...(giveUp ? { status: "past_due", expiresAt: new Date() } : {}) },
  });
  void sendEmail(
    shop,
    cp.customerEmail,
    giveUp ? `Your ${cp.package.name} has been paused` : `We couldn't renew your ${cp.package.name}`,
    `<p>Hi ${escapeHtml(cp.customerName)},</p><p>${
      giveUp
        ? "We tried several times but couldn't charge your payment method, so your subscription is paused."
        : "Your renewal payment didn't go through. We'll try again tomorrow."
    }</p><p>Reason: ${escapeHtml(a.errorMessage ?? "payment declined")}</p>
    <p><a href="${escapeHtml(manageLink(shop.shopDomain, cp.manageToken))}">Manage your subscription</a></p>`,
    "payment",
  ).catch(() => {});
}

/** Cancels the Shopify contract (merchant or customer) and ends the package. */
export async function cancelContract(shop: Shop, cp: CustomerPackage) {
  if (cp.subscriptionContractId) {
    const data = await shopGraphql(
      shop.shopDomain,
      `#graphql
      mutation BookwellCancelContract($id: ID!) {
        subscriptionContractCancel(subscriptionContractId: $id) { contract { id status } userErrors { message } }
      }`,
      { id: cp.subscriptionContractId },
    );
    const err = firstError(data, "subscriptionContractCancel");
    if (err) throw new Error(err);
  }
  // Keep access until the end of the period already paid for.
  await prisma.customerPackage.update({
    where: { id: cp.id },
    data: { status: "cancelled", expiresAt: cp.nextBillingDate ?? new Date() },
  });
}

/** Cancelled-but-paid memberships stay usable until their period ends. */
export function isUsable(cp: Pick<CustomerPackage, "status" | "expiresAt">) {
  const notExpired = !cp.expiresAt || cp.expiresAt.getTime() > Date.now();
  return (cp.status === "active" || cp.status === "cancelled") && notExpired;
}

export { manageLink as membershipManageUrl };
