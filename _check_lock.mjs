import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const locks = await prisma.$queryRawUnsafe(`
  SELECT l.pid, l.granted, a.state, a.query, a.query_start, a.state_change
  FROM pg_locks l
  JOIN pg_stat_activity a ON l.pid = a.pid
  WHERE l.locktype = 'advisory'
`);
console.log(JSON.stringify(locks, null, 2));
await prisma.$disconnect();
