// Hostinger's "Web App" runtime (and similar platforms) expects a single
// JS file it can run directly with `node <entry>` — not an npm script
// chain. This file is that entry point: it applies any pending Postgres
// migrations, then starts the actual Remix server via remix-serve,
// which reads PORT from the environment on its own.
import { execSync } from "node:child_process";

function run(command) {
  try {
    execSync(command, { stdio: "pipe" });
  } catch (error) {
    // execSync's thrown error carries the child's real stdout/stderr —
    // surface it explicitly, since "inherit" alone hasn't been showing
    // up in this host's log viewer.
    console.error(`FAILED: ${command}`);
    console.error("stdout:", error.stdout?.toString());
    console.error("stderr:", error.stderr?.toString());
    throw error;
  }
}

run("npx prisma migrate deploy");
execSync("npx remix-serve ./build/server/index.js", { stdio: "inherit" });
