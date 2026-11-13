import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The real root.tsx, with Remix's router-bound pieces stubbed out, so we can
// assert on the <head> that Shopify's embedded-app check reads.
let path = "/app/bookings";
let query = "";
vi.mock("@remix-run/react", () => ({
  Links: () => null,
  Meta: () => null,
  Outlet: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
  useLoaderData: () => ({ apiKey: "test_key_123" }),
  useLocation: () => ({ pathname: path, search: query }),
}));

import App from "../app/root";

const head = () => renderToStaticMarkup(<App />).match(/<head>[\s\S]*<\/head>/)![0];
const SCRIPT = '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="test_key_123">';

describe("App Bridge script in <head>", () => {
  it("is the first script in <head> on admin pages, sync, with the API key", () => {
    for (const p of ["/app", "/app/bookings", "/app/services/abc"]) {
      path = p;
      const h = head();
      expect(h).toContain(SCRIPT);
      expect(h).toContain('<meta name="shopify-api-key" content="test_key_123"/>');
      expect(h.indexOf("<script")).toBe(h.indexOf(SCRIPT)); // first script
      expect(h).not.toMatch(/<script[^>]*(async|defer|type="module")/);
      expect(h.match(/app-bridge\.js/g)).toHaveLength(1);
    }
  });
  it("is also present on the embedded entry URL", () => {
    path = "/";
    query = "?embedded=1&host=abc&shop=x.myshopify.com";
    expect(head()).toContain(SCRIPT);
    query = "";
  });
  it("is not added to public pages", () => {
    for (const p of ["/privacy", "/support", "/security", "/book"]) {
      path = p;
      expect(head()).not.toContain("app-bridge.js");
    }
  });
});
