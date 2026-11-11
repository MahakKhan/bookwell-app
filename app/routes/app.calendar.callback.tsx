import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "../db.server";
import { exchangeCodeForTokens } from "../models/calendar.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

// Google redirects here as a bare top-level navigation (connect.tsx sent
// the browser out of the Shopify admin iframe entirely), so there's no
// Shopify session/cookie to authenticate against — the shop that
// started this flow travels in `state` instead (set in connect.tsx).
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shopDomain = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return new Response(`Google declined: ${error}`, { status: 400 });
  if (!code || !shopDomain) return new Response("Missing code or state", { status: 400 });

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  const tokens = await exchangeCodeForTokens(code, `${appUrl}/app/calendar/callback`);

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      googleAccessToken: tokens.access_token,
      googleRefreshToken: tokens.refresh_token ?? shop.googleRefreshToken,
      googleTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
      twoWaySyncOn: true,
    },
  });

  const handle = shopDomain.replace(".myshopify.com", "");
  return redirect(`https://admin.shopify.com/store/${handle}/apps/bookwell/app/settings`);
}
