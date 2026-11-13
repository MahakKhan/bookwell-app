import type { LoaderFunctionArgs } from "@remix-run/node";
import QRCode from "qrcode";

// /apps/booking/qrcode?token=... (via the app proxy, so it works in emails)
// → a PNG QR code of "BW:<token>", the booking's ticket. Scanning it on
// Bookwell → Check-in finds the booking. It only encodes the token it is
// given, so no booking data is read here.
export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[a-z0-9]{16,40}$/i.test(token)) return new Response("Bad token", { status: 400 });
  const png = await QRCode.toBuffer(`BW:${token}`, { width: 320, margin: 1, errorCorrectionLevel: "M" });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
