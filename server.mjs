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

// `npx` isn't on PATH in this platform's runtime container (only
// available during the build step), and even plain `node` isn't on
// PATH for a spawned subshell — only this already-running process
// knows where its own binary lives. Use process.execPath to invoke
// the .bin shims directly, bypassing their shebang/PATH resolution.
const node = process.execPath;
run(`${node} node_modules/.bin/prisma migrate deploy`);
execSync(`${node} node_modules/.bin/remix-serve ./build/server/index.js`, { stdio: "inherit" });
