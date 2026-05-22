import { PrismaClient } from '@prisma/client';

// Single shared instance across the entire server process.
// Prevents connection-pool exhaustion from multiple `new PrismaClient()` calls
// in parsers.ts, reconciliation.ts, and index.ts.
const prisma = new PrismaClient();

export default prisma;
