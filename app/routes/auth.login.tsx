import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// A visit to /auth/login with a shop restarts the install/auth flow; without
// one (e.g. someone opening the app host directly) show a clear message
// instead of an error.
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = new URL(request.url).searchParams.get("shop");
  if (shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  return null;
}

export default function AuthLogin() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "15vh auto", padding: 16, textAlign: "center" }}>
      <h1 style={{ fontSize: 22 }}>Open Bookwell from your Shopify admin</h1>
      <p style={{ color: "#555" }}>
        Go to your Shopify admin, choose Apps, then Bookwell. If you need help, visit <a href="/support">our support page</a>.
      </p>
    </main>
  );
}
