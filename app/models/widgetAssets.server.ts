import fs from "node:fs/promises";
import path from "node:path";

// The storefront widget lives in the theme app extension. The standalone
// booking page (/apps/booking/book) loads the very same files through the app
// proxy, so there's one widget to maintain.
const cache = new Map<string, { body: string; at: number }>();

export async function widgetAsset(file: "booking.js" | "booking.css", contentType: string) {
  const hit = cache.get(file);
  let body = hit && Date.now() - hit.at < (process.env.NODE_ENV === "production" ? 3_600_000 : 2_000) ? hit.body : null;
  if (!body) {
    body = await fs.readFile(path.join(process.cwd(), "extensions", "booking-widget", "assets", file), "utf8");
    cache.set(file, { body, at: Date.now() });
  }
  return new Response(body, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300" },
  });
}
