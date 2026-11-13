import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncPendingPayments } from "../models/lifecycle.server";

// Optional fast path for deposit/prepayment confirmation. NOT subscribed in
// shopify.app.toml by default: the orders/paid payload carries customer PII,
// which needs Protected Customer Data access. Without it the background job in
// jobs.server.ts confirms paid checkouts within a minute anyway.
export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await authenticate.webhook(request);
  const shopRow = await prisma.shop.findUnique({ where: { shopDomain: shop } });
  if (shopRow) await syncPendingPayments(shopRow);
  return new Response();
}
