import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [remix(), tsconfigPaths()],
  server: {
    port: Number(process.env.PORT || 3000),
    strictPort: true,
    // The dev tunnel's hostname changes every run (ephemeral Cloudflare
    // quick tunnel), so it can't be listed explicitly — allow any host
    // in dev. Safe here because this only ever runs locally.
    allowedHosts: true,
  },
});
