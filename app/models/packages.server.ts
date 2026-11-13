import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { shopGraphql } from "./lifecycle.server";
import { upsertCustomer } from "./booking.server";

// Class packs (N credits) and memberships (unlimited until expiry). Bought
// once through Shopify checkout (or granted by the merchant), then redeemed
// on bookings by the customer's email instead of paying per booking.

export function packageCovers(pkg: { serviceIds: string[] }, serviceId: string) {
  return pkg.serviceIds.length === 0 || pkg.serviceIds.includes(serviceId);
}

/** The soonest-expiring active package this customer can use for `sessions` bookings. */
export async function findUsablePackage(shopId: string, email: string, serviceId: string, sessions: number) {
  const now = new Date();
  const list = await prisma.customerPackage.findMany({
    where: {
      shopId,
      customerEmail: email.trim().toLowerCase(),
      OR: [
        { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { status: "cancelled", subscriptionContractId: { not: null }, expiresAt: { gt: now } },
      ],
    },
    include: { package: true },
    orderBy: { expiresAt: "asc" },
  });
  return list.find((cp) => packageCovers(cp.package, serviceId) && (cp.creditsLeft === null || cp.creditsLeft >= sessions)) ?? null;
}

/** Atomically takes `n` credits (no-op for memberships). False if not enough left. */
export async function consumeCredits(customerPackageId: string, n: number) {
  const cp = await prisma.customerPackage.findUnique({ where: { id: customerPackageId } });
  if (!cp || !["active", "cancelled"].includes(cp.status)) return false;
  if (cp.creditsLeft === null) return true;
  const r = await prisma.customerPackage.updateMany({
    where: { id: customerPackageId, creditsLeft: { gte: n } },
    data: { creditsLeft: { decrement: n } },
  });
  return r.count > 0;
}

export async function refundCredits(customerPackageId: string, n: number) {
  await prisma.customerPackage.updateMany({
    where: { id: customerPackageId, creditsLeft: { not: null } },
    data: { creditsLeft: { increment: n } },
  });
}

function activation(pkg: { credits: number | null; validityDays: number; kind: string }) {
  return {
    status: "active",
    creditsLeft: pkg.kind === "membership" ? null : Math.max(1, pkg.credits ?? 1),
    expiresAt: pkg.validityDays > 0 ? new Date(Date.now() + pkg.validityDays * 86_400_000) : null,
  };
}

/** Merchant gives a package directly (paid in store, gift, etc.). */
export async function grantPackage(shop: Shop, packageId: string, c: { name: string; email: string }) {
  const pkg = await prisma.package.findFirst({ where: { id: packageId, shopId: shop.id } });
  if (!pkg) throw new Error("Package not found.");
  const customer = await upsertCustomer(shop.id, c);
  return prisma.customerPackage.create({
    data: {
      shopId: shop.id,
      packageId: pkg.id,
      customerId: customer.id,
      customerEmail: customer.email,
      customerName: c.name,
      source: "admin",
      ...activation(pkg),
    },
  });
}

/** Storefront purchase: creates a pending package and a Shopify checkout for it. */
export async function buyPackage(shop: Shop, packageId: string, c: { name: string; email: string }) {
  const pkg = await prisma.package.findFirst({ where: { id: packageId, shopId: shop.id, active: true } });
  if (!pkg) throw new Error("That package isn't available.");
  const customer = await upsertCustomer(shop.id, c);
  if (Number(pkg.price) <= 0) {
    return { checkoutUrl: null, cp: await prisma.customerPackage.create({ data: { shopId: shop.id, packageId: pkg.id, customerId: customer.id, customerEmail: customer.email, customerName: c.name, ...activation(pkg) } }) };
  }
  const cp = await prisma.customerPackage.create({
    data: { shopId: shop.id, packageId: pkg.id, customerId: customer.id, customerEmail: customer.email, customerName: c.name, status: "pending" },
  });
  const data = await shopGraphql(
    shop.shopDomain,
    `#graphql
    mutation BookwellPackage($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { message } }
    }`,
    {
      input: {
        note: `Bookwell package ${cp.id}`,
        tags: ["bookwell", "bookwell-package"],
        customAttributes: [{ key: "bookwell_package_id", value: cp.id }],
        lineItems: [
          {
            title: pkg.name,
            quantity: 1,
            requiresShipping: false,
            taxable: false,
            originalUnitPriceWithCurrency: { amount: Number(pkg.price).toFixed(2), currencyCode: shop.currency || "USD" },
            customAttributes: [
              { key: "Includes", value: pkg.kind === "membership" ? "Unlimited bookings" : `${pkg.credits} sessions` },
              ...(pkg.validityDays > 0 ? [{ key: "Valid for", value: `${pkg.validityDays} days` }] : []),
            ],
          },
        ],
      },
    },
  );
  const draft = data?.data?.draftOrderCreate?.draftOrder;
  if (!draft?.invoiceUrl) {
    await prisma.customerPackage.update({ where: { id: cp.id }, data: { status: "cancelled" } });
    throw new Error("Online payment is not available right now. Please try again later.");
  }
  await prisma.customerPackage.update({ where: { id: cp.id }, data: { draftOrderId: draft.id, checkoutUrl: draft.invoiceUrl } });
  return { checkoutUrl: draft.invoiceUrl as string, cp };
}

/** Activates paid package checkouts, drops abandoned ones, expires old ones. */
export async function syncPackages(shop: Shop) {
  const pending = await prisma.customerPackage.findMany({
    where: { shopId: shop.id, status: "pending", draftOrderId: { not: null } },
    include: { package: true },
    take: 50,
  });
  for (const cp of pending) {
    try {
      const data = await shopGraphql(
        shop.shopDomain,
        `#graphql
        query BookwellPkgDraft($id: ID!) { draftOrder(id: $id) { status order { id } } }`,
        { id: cp.draftOrderId },
      );
      const draft = data?.data?.draftOrder;
      if (draft?.status === "COMPLETED" && draft.order?.id) {
        await prisma.customerPackage.update({ where: { id: cp.id }, data: { ...activation(cp.package), shopifyOrderId: draft.order.id } });
      } else if (!draft || Date.now() - cp.createdAt.getTime() > 3 * 86_400_000) {
        await prisma.customerPackage.update({ where: { id: cp.id }, data: { status: "cancelled" } });
      }
    } catch (e) {
      console.error("[bookwell] package sync", e);
    }
  }
  await prisma.customerPackage.updateMany({
    where: { shopId: shop.id, status: "active", subscriptionContractId: null, expiresAt: { lt: new Date() } },
    data: { status: "expired" },
  });
}
