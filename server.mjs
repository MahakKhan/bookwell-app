// Hostinger's "Web App" runtime (and similar platforms) expects a single
// JS file it can run directly with `node <entry>` — not an npm script
// chain. This file is that entry point: it applies any pending Postgres
// migrations, then starts the actual Remix server via remix-serve,
// which reads PORT from the environment on its own.
import { execSync } from "node:child_process";

execSync("npx prisma migrate deploy", { stdio: "inherit" });
execSync("npx remix-serve ./build/server/index.js", { stdio: "inherit" });
