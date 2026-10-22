import { PrismaClient, type Prisma } from '@prisma/client';

export interface CreatePrismaClientOptions {
  url: string;
  log?: Prisma.LogLevel[];
}

export function createPrismaClient({ url, log = ['warn', 'error'] }: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } }, log });
}

export type CanonPrismaClient = PrismaClient;
