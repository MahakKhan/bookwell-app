import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, NavLink, Outlet, useLoaderData, useLocation, useNavigation, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import bookwellStyles from "../styles/bookwell.css?url";
import { authenticate } from "../shopify.server";
import { syncShopFromShopify } from "../models/shop.server";
import { usageFor } from "../models/billing.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap",
  },
  { rel: "stylesheet", href: bookwellStyles },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await syncShopFromShopify(admin, session.shop);
  const u = await usageFor(shop);
  return json({
    apiKey: process.env.SHOPIFY_API_KEY || "",
    planLabel: u.plan.name,
    usage: { used: u.used, limit: u.limit, hardLimit: u.hardLimit, resets: u.cycleEnd.toISOString().slice(0, 10) },
  });
}

// Shopify identifies the store/session through these query params. Dropping
// them (as a plain "/app/services" link does) breaks any full-page load, e.g.
// a click before the page has hydrated, which looks like a dead sidebar.
const KEEP = ["shop", "host", "embedded", "locale"];

export default function AppLayout() {
  const { apiKey, usage } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigation = useNavigation();
  const kept = new URLSearchParams();
  const current = new URLSearchParams(location.search);
  KEEP.forEach((k) => {
    const v = current.get(k);
    if (v) kept.set(k, v);
  });
  const search = kept.toString() ? `?${kept.toString()}` : "";
  const loading = navigation.state !== "idle";

  return (
    // App Bridge's <script> is rendered once, first in <head>, by root.tsx;
    // isEmbeddedApp={false} keeps AppProvider from adding a second copy.
    <AppProvider isEmbeddedApp={false} apiKey={apiKey}>
      {/* Shopify's own sidebar keeps its native app menu... */}
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/onboarding">Setup guide</Link>
        <Link to="/app/bookings">Bookings</Link>
        <Link to="/app/calendar">Calendar</Link>
        <Link to="/app/services">Services</Link>
        <Link to="/app/customers">Customers</Link>
        <Link to="/app/staff">Team</Link>
        <Link to="/app/checkin">Check-in</Link>
        <Link to="/app/integrations">Integrations</Link>
        <Link to="/app/billing">Billing</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>

      {/* Navigation lives in Shopify's own sidebar (NavMenu above). */}
      <div className="bw-app">
        <div className={`bw-progress${loading ? " on" : ""}`} aria-hidden="true" />
        <div className="bw-shell bw-shell-full">
          <main className="bw-main">
            {usage.limit !== null && usage.used >= usage.limit * 0.8 && (
              <div className={`bw-alert ${usage.used >= usage.limit ? "err" : "warn"}`}>
                {usage.used >= (usage.hardLimit ?? Infinity)
                  ? `Online booking is paused: you've used ${usage.used} of ${usage.limit} bookings this cycle (resets ${usage.resets}).`
                  : usage.used >= usage.limit
                    ? `You've reached your plan's ${usage.limit} bookings. Bookings continue up to ${usage.hardLimit}, then pause until ${usage.resets}.`
                    : `You've used ${usage.used} of ${usage.limit} bookings this cycle.`}{" "}
                <NavLink to={{ pathname: "/app/billing", search }}>Upgrade</NavLink>
              </div>
            )}
            <Outlet />
          </main>
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) =>
  boundary.headers(headersArgs);
