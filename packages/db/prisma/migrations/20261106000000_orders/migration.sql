-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'CONFIRMED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "currency" TEXT NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "customer" JSONB NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_siteId_number_key" ON "orders"("siteId", "number");

-- CreateIndex
CREATE INDEX "orders_tenantId_siteId_status_createdAt_idx" ON "orders"("tenantId", "siteId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Amounts are never negative; a currency is an ISO 4217 code.
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_check" CHECK ("subtotal" >= 0 AND "total" >= 0 AND "number" > 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Tenant isolation, as for every tenant table.
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "orders" USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());
