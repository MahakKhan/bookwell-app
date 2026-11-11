import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { BillingConfigSubscriptionLineItemPlan } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PLAN_ENTRY, PLAN_GROWTH } from "./plans";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  // `shopify app dev` injects the current tunnel URL as HOST, not
  // SHOPIFY_APP_URL (that name only applies to a real deployment's own
  // env config). SHOPIFY_APP_URL still wins if it's set, so this works
  // unchanged once this app is actually deployed somewhere.
  appUrl: process.env.SHOPIFY_APP_URL || process.env.HOST || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [PLAN_ENTRY]: {
      trialDays: 7,
      lineItems: [
        { amount: 9, currencyCode: "USD", interval: BillingInterval.Every30Days },
      ],
    } satisfies BillingConfigSubscriptionLineItemPlan,
    [PLAN_GROWTH]: {
      trialDays: 7,
      lineItems: [
        { amount: 19, currencyCode: "USD", interval: BillingInterval.Every30Days },
      ],
    } satisfies BillingConfigSubscriptionLineItemPlan,
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // Required for new apps as of April 2026 — without this the Admin
    // API flatly rejects every GraphQL call with a 403 (legacy
    // non-expiring offline tokens are no longer accepted). Needs
    // Session.refreshToken / refreshTokenExpires columns (see schema).
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
