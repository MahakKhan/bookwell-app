import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { googleOAuthUrl } from "../models/calendar.server";

const appUrl = process.env.SHOPIFY_APP_URL || process.env.HOST || "";

// Linked from the Settings page as a plain top-level navigation (not
// inside the embedded admin iframe — Google's consent screen refuses to
// render in an iframe). Redirects straight to Google; the shop domain
// travels in `state` so the callback can find its way back without
// needing a session cookie Google's redirect wouldn't carry anyway.
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  if (!process.env.GOOGLE_CLIENT_ID) {
    return new Response(
      "Google Calendar sync isn't configured yet: this app's GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are empty. Create an OAuth client in Google Cloud Console, add this redirect URI, and set those two env vars.",
      { status: 500 },
    );
  }

  const redirectUri = `${appUrl}/app/calendar/callback`;
  return redirect(googleOAuthUrl(redirectUri, session.shop));
}
