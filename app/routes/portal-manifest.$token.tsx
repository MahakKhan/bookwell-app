import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

// Web app manifest for the team portal, so team members can install it on
// their phone's home screen and open it like an app.
export async function loader({ params }: LoaderFunctionArgs) {
  const token = params.token || "";
  const m = token.length >= 16 ? await prisma.staffMember.findFirst({ where: { portalToken: token, portalAccess: true, active: true }, select: { name: true } }) : null;
  if (!m) return new Response("Not found", { status: 404 });
  const manifest = {
    name: `Bookwell · ${m.name}`,
    short_name: "Bookwell",
    description: "Your bookings and working hours",
    start_url: `/portal/${token}`,
    scope: `/portal/${token}`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f6fb",
    theme_color: "#5b5bd6",
    icons: [
      { src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, max-age=3600" } });
}
