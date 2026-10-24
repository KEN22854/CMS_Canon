-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('SAML');

-- AlterTable
ALTER TABLE "plugin_instances" ADD COLUMN     "apiKeyId" TEXT,
ADD COLUMN     "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" TEXT NOT NULL DEFAULT '0.0.0';

-- AlterTable
ALTER TABLE "plugins" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'integration',
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "webhook_deliveries" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "error" TEXT;

-- AlterTable
ALTER TABLE "webhooks" ADD COLUMN     "disabledReason" TEXT,
ADD COLUMN     "pluginInstanceId" TEXT;

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "plan" "TenantPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenantId" TEXT,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_digests" (
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_digests_pkey" PRIMARY KEY ("tenantId","day")
);

-- CreateTable
CREATE TABLE "sso_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL DEFAULT 'SAML',
    "name" TEXT NOT NULL,
    "domains" TEXT[],
    "idpEntityId" TEXT NOT NULL,
    "idpSsoUrl" TEXT NOT NULL,
    "idpCertificate" TEXT NOT NULL,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "jitProvisioning" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripeSubscriptionId_key" ON "subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "billing_events_tenantId_createdAt_idx" ON "billing_events"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_tenantId_key" ON "sso_connections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_instances_apiKeyId_key" ON "plugin_instances"("apiKeyId");

-- CreateIndex
CREATE INDEX "plugin_instances_tenantId_idx" ON "plugin_instances"("tenantId");

-- CreateIndex
CREATE INDEX "plugins_tenantId_idx" ON "plugins"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_pluginInstanceId_key" ON "webhooks"("pluginInstanceId");

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_pluginInstanceId_fkey" FOREIGN KEY ("pluginInstanceId") REFERENCES "plugin_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, same policy as every other tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'sso_connections', 'audit_digests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant())', t);
  END LOOP;
END
$$;

-- Marketplace plugins (tenantId NULL) are visible to everyone; private plugins only to their tenant.
ALTER TABLE "plugins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plugins" FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_visibility ON "plugins" USING ("tenantId" IS NULL OR "tenantId" = canon_current_tenant()) WITH CHECK ("tenantId" = canon_current_tenant());

-- Billing state changes only through verified Stripe webhooks (system role); digests are written by
-- the audit job. The request-path role can read its own rows but never rewrite history.
REVOKE ALL ON "billing_events" FROM canon_app;
REVOKE INSERT, UPDATE, DELETE ON "audit_digests" FROM canon_app;
REVOKE INSERT, UPDATE, DELETE ON "subscriptions" FROM canon_app;
