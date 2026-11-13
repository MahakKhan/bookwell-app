import crypto from "node:crypto";

// Encrypts third-party credentials (Resend/Twilio keys, Google tokens)
// before they hit the database. The key comes from ENCRYPTION_KEY if set,
// else is derived from the Shopify API secret. Values already stored in
// plaintext (from before this existed) still read fine and get encrypted
// the next time they're saved.

const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const secret = process.env.ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string): string {
  const k = key();
  if (!k) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;
  const k = key();
  if (!k) return null;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Signed, expiring `state` for the Google OAuth round trip, so the
// callback can't be pointed at an arbitrary shop by a forged link.
export function signState(shopDomain: string): string {
  const ts = Date.now().toString();
  const mac = crypto
    .createHmac("sha256", key() ?? "dev")
    .update(`${shopDomain}.${ts}`)
    .digest("hex");
  return `${shopDomain}.${ts}.${mac}`;
}

export function verifyState(state: string | null): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length < 3) return null;
  const mac = parts.pop()!;
  const ts = parts.pop()!;
  const shopDomain = parts.join(".");
  const expected = crypto
    .createHmac("sha256", key() ?? "dev")
    .update(`${shopDomain}.${ts}`)
    .digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(ts) > 15 * 60_000) return null;
  return shopDomain;
}
