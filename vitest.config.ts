import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Some modules import the Shopify client at load time; give it dummy values.
    env: { SHOPIFY_APP_URL: "https://example.com", SHOPIFY_API_KEY: "test", SHOPIFY_API_SECRET: "test-secret", BOOKWELL_DISABLE_JOBS: "true" },
  },
});
