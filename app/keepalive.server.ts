// Keeps a Render free-plan instance from spinning down after 15 minutes idle
// by requesting our own public /healthz every 10 minutes. Production only;
// set KEEP_ALIVE=off to disable. Harmless on paid plans.

const INTERVAL_MS = 10 * 60_000;

const g = globalThis as unknown as { __bookwellKeepAlive?: boolean };

export function startKeepAlive() {
  if (g.__bookwellKeepAlive) return; // once per process (dev reloads, HMR)
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.KEEP_ALIVE === "off") return;

  const base = process.env.RENDER_EXTERNAL_URL || process.env.SHOPIFY_APP_URL;
  if (!base) return;
  g.__bookwellKeepAlive = true;

  const url = `${base.replace(/\/+$/, "")}/healthz`;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      console.log(`[keep-alive] ${url} -> ${res.status}`);
    } catch (err) {
      console.error("[keep-alive] failed:", err instanceof Error ? err.message : err);
    }
  }, INTERVAL_MS);
  timer.unref?.();
}
