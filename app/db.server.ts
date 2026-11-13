import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (!global.prismaGlobal) {
  global.prismaGlobal = new PrismaClient();
  warm(global.prismaGlobal);
}

const prisma: PrismaClient = global.prismaGlobal;

export default prisma;

// The database is a remote Postgres: opening a connection costs ~2s and every
// query a full round trip. Open a few connections up front and ping
// periodically (dev and production) so a request never pays for a cold connection or for the
// serverless database having gone to sleep after idling.
function warm(client: PrismaClient) {
  const ping = () => Promise.all([1, 2, 3, 4].map(() => client.$queryRaw`select 1`)).catch(() => {});
  void ping();
  const timer = setInterval(ping, 4 * 60_000);
  timer.unref?.();
}
