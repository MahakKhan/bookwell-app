import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { decrypt, encrypt } from "./crypto.server";

// Zoom: the merchant connects their own Zoom account (OAuth, bring-your-own
// ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET from a Zoom "General app"), and every
// booking for a service set to "Zoom" gets its own meeting. Like the other
// integrations, every call no-ops instead of throwing when not connected.

const API = "https://api.zoom.us/v2";
const TOKEN_URL = "https://zoom.us/oauth/token";

export const zoomConfigured = () => Boolean(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
const basic = () => `Basic ${Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64")}`;

export function zoomOAuthUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: process.env.ZOOM_CLIENT_ID || "", redirect_uri: redirectUri, state });
  return `https://zoom.us/oauth/authorize?${q}`;
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number };

export async function exchangeZoomCode(code: string, redirectUri: string): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`Zoom token exchange failed: ${await res.text()}`);
  return res.json() as Promise<Tokens>;
}

export function saveZoomTokens(shopId: string, t: Tokens) {
  return prisma.shop.update({
    where: { id: shopId },
    data: {
      zoomAccessToken: encrypt(t.access_token),
      zoomRefreshToken: encrypt(t.refresh_token),
      zoomTokenExpiry: new Date(Date.now() + t.expires_in * 1000),
    },
  });
}

// Zoom rotates refresh tokens: the new one must be stored every time.
async function accessToken(shop: Shop): Promise<string | null> {
  const fresh = await prisma.shop.findUnique({ where: { id: shop.id } });
  if (!fresh) return null;
  const refresh = decrypt(fresh.zoomRefreshToken);
  if (!refresh || !zoomConfigured()) return null;
  const cached = decrypt(fresh.zoomAccessToken);
  if (cached && fresh.zoomTokenExpiry && fresh.zoomTokenExpiry.getTime() - Date.now() > 60_000) return cached;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as Tokens;
  await saveZoomTokens(shop.id, t);
  return t.access_token;
}

export async function createZoomMeeting(
  shop: Shop,
  m: { topic: string; startsAt: Date; durationMinutes: number; agenda?: string },
): Promise<{ id: string; joinUrl: string } | null> {
  const token = await accessToken(shop);
  if (!token) return null;
  try {
    const res = await fetch(`${API}/users/me/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: m.topic.slice(0, 200),
        type: 2,
        start_time: m.startsAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        duration: Math.max(1, Math.round(m.durationMinutes)),
        timezone: shop.timezone,
        agenda: m.agenda?.slice(0, 2000),
        settings: { join_before_host: false, waiting_room: true, approval_type: 2 },
      }),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { id: number; join_url: string };
    return { id: String(d.id), joinUrl: d.join_url };
  } catch {
    return null;
  }
}

export async function updateZoomMeeting(shop: Shop, meetingId: string, m: { startsAt: Date; durationMinutes: number }) {
  const token = await accessToken(shop);
  if (!token) return;
  await fetch(`${API}/meetings/${encodeURIComponent(meetingId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ start_time: m.startsAt.toISOString().replace(/\.\d{3}Z$/, "Z"), duration: Math.max(1, Math.round(m.durationMinutes)), timezone: shop.timezone }),
  }).catch(() => {});
}

export async function deleteZoomMeeting(shop: Shop, meetingId: string) {
  const token = await accessToken(shop);
  if (!token) return;
  await fetch(`${API}/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}
