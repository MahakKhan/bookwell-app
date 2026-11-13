import type { Shop } from "@prisma/client";
import prisma from "../db.server";

// Every admin request needs the Shop row, often twice (layout + page), and
// each database round trip is expensive. Cache it briefly per process and
// drop the entry whenever we change the row.
const TTL_MS = 15_000;
const cache = new Map<string, { shop: Shop; at: number }>();

export function invalidateShop(shopDomain: string) {
  cache.delete(shopDomain);
}

export async function getShop(shopDomain: string): Promise<Shop> {
  const hit = cache.get(shopDomain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.shop;

  let shop: Shop;
  try {
    shop = await prisma.shop.upsert({
      where: { shopDomain },
      update: {},
      create: { shopDomain },
    });
  } catch (e: any) {
    // Parallel first-load requests can race the insert; just read the winner.
    if (e?.code !== "P2002") throw e;
    shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain } });
  }
  cache.set(shopDomain, { shop, at: Date.now() });
  return shop;
}

const storeChecked = new Set<string>();

// Reads the store's real settings from Shopify once per server run: its
// currency (prices, deposits and checkouts must use it, not an assumed USD)
// and, while the timezone is still the "UTC" default, its IANA timezone.
export async function syncShopFromShopify(
  admin: { graphql: (q: string) => Promise<Response> },
  shopDomain: string,
) {
  const shop = await getShop(shopDomain);
  if (storeChecked.has(shopDomain)) return shop;
  storeChecked.add(shopDomain);
  try {
    const res = await admin.graphql(`#graphql
      query { shop { ianaTimezone currencyCode } }`);
    const data = await res.json();
    const tz = data?.data?.shop?.ianaTimezone as string | undefined;
    const currency = data?.data?.shop?.currencyCode as string | undefined;
    const patch: { timezone?: string; currency?: string } = {};
    if (tz && tz !== "UTC" && shop.timezone === "UTC") patch.timezone = tz;
    if (currency && /^[A-Z]{3}$/.test(currency) && currency !== shop.currency) patch.currency = currency;
    if (Object.keys(patch).length) {
      const updated = await prisma.shop.update({ where: { id: shop.id }, data: patch });
      cache.set(shopDomain, { shop: updated, at: Date.now() });
      return updated;
    }
  } catch {
    storeChecked.delete(shopDomain); // try again next load
  }
  return shop;
}
