// Hostinger's "Web App" runtime (and similar platforms) expects a single
// JS file it can run directly with `node <entry>` — not an npm script
// chain, and not one that does slow work on every cold start (this
// platform spins up a fresh process per request rather than keeping one
// warm, so anything here runs far more often than you'd expect).
// Migrations run once at build time instead — see the Build command —
// so this just starts the actual server.
import { execSync } from "node:child_process";

execSync(`${process.execPath} node_modules/.bin/remix-serve ./build/server/index.js`, {
  stdio: "inherit",
});
