import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
} from "@remix-run/react";

// The public API key (it is also in every embedded page's HTML) so the
// App Bridge script tag can be rendered here, in <head>.
export const loader = (_args: LoaderFunctionArgs) =>
  json({ apiKey: process.env.SHOPIFY_API_KEY || "" });

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const { pathname, search } = useLocation();
  // Embedded admin pages: /app/* and the "/" entry that redirects into it.
  const inAdmin = pathname === "/app" || pathname.startsWith("/app/") || (pathname === "/" && search.includes("host="));
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/*
          Shopify requires App Bridge as the FIRST script in <head>, loaded
          synchronously from its CDN (no async/defer/module) with the app's
          API key, on every page that renders inside the admin. Public pages
          (privacy, support, storefront booking pages) don't use it.
        */}
        {apiKey && inAdmin && <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
