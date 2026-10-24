-- AlterTable
ALTER TABLE "sso_connections" ADD COLUMN     "verifiedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

