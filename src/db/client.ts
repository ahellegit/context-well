import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the app process.
export const prisma = new PrismaClient();
