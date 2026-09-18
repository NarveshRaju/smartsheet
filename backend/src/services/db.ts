import { PrismaClient } from '@prisma/client';

// One connection pool per process (shared by HTTP handlers and workers).
export const prisma = new PrismaClient();
