import prisma from "../db.server";

// Render's health check: 200 only if the app can reach the database.
export async function loader() {
  try {
    await prisma.$queryRaw`select 1`;
    return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("database unavailable", { status: 503 });
  }
}
