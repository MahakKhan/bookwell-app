import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// authenticate.admin loads the session on every request (twice per page: the
// layout route and the page route). Against a remote database that is a full
// round trip each time, so keep sessions in memory for a short while. Any
// write or delete clears the entry, so rotated/expiring tokens stay correct.
const baseSessionStorage = new PrismaSessionStorage(prisma);
const SESSION_TTL_MS = 30_000;
const sessionCache = new Map<string, { session: Session; at: number }>();

const sessionStorage = {
  async storeSession(session: Session) {
    sessionCache.delete(session.id);
    return baseSessionStorage.storeSession(session);
  },
  async loadSession(id: string) {
    const hit = sessionCache.get(id);
    if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.session;
    const session = await baseSessionStorage.loadSession(id);
    if (session) sessionCache.set(id, { session, at: Date.now() });
    return session;
  },
  async deleteSession(id: string) {
    sessionCache.delete(id);
    return baseSessionStorage.deleteSession(id);
  },
  async deleteSessions(ids: string[]) {
    ids.forEach((id) => sessionCache.delete(id));
    return baseSessionStorage.deleteSessions(ids);
  },
  async findSessionsByShop(shop: string) {
    return baseSessionStorage.findSessionsByShop(shop);
  },
};

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
  sessionStorage,
  distribution: AppDistribution.AppStore,
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
// Charges are Shopify "test" charges (no real money) unless BILLING_LIVE=true
// is set in the production environment.
export const BILLING_IS_TEST = process.env.BILLING_LIVE !== "true";
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;

