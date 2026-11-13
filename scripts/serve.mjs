// Serves the production build under `shopify app dev`.
// The Shopify CLI puts the public tunnel URL in HOST, but remix-serve treats
// HOST as the network interface to listen on. Move the URL to SHOPIFY_APP_URL
// (which the app reads first) and listen on localhost instead.
import { spawn } from "node:child_process";

const env = { ...process.env };
if (env.HOST && /^https?:\/\//.test(env.HOST)) {
  env.SHOPIFY_APP_URL ||= env.HOST;
  env.HOST = "localhost";
}
env.NODE_ENV = "production";

const child = spawn(process.execPath, ["node_modules/@remix-run/serve/dist/cli.js", "./build/server/index.js"], {
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
