import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// Shopify embeds the app at its bare application_url ("/"), carrying
// shop/host/embedded query params that the real admin UI (under /app)
// needs. Without this redirect, "/" matches no route and renders
// nothing — which is exactly the blank iframe this was built to fix.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/app${url.search}`);
}
