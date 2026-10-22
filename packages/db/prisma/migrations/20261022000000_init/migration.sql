-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'PRO', 'BUSINESS', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TenantIsolation" AS ENUM ('SHARED', 'SCHEMA', 'DATABASE');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentEntityType" AS ENUM ('PAGE', 'ENTRY', 'MEDIA', 'FORM', 'FACT');

-- CreateEnum
CREATE TYPE "ScheduledAction" AS ENUM ('PUBLISH', 'UNPUBLISH');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('NEW', 'READ', 'ARCHIVED', 'SPAM');

-- CreateEnum
CREATE TYPE "AbTestStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('TEXT', 'REWRITE', 'TRANSLATE', 'SEO', 'ALT_TEXT', 'IMAGE', 'CODE', 'CHAT', 'EMBEDDING', 'CLASSIFY', 'SUMMARIZE', 'FACT_CHECK', 'FACT_EXTRACT', 'FACT_PROPAGATE', 'AGENT_STEP');

-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('PENDING', 'STREAMING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'DEGRADED');

-- CreateEnum
CREATE TYPE "AiAgentType" AS ENUM ('CONTENT_STRATEGIST', 'SEO_SPECIALIST', 'COPYWRITER', 'DESIGNER', 'FACT_CHECKER', 'TRANSLATOR', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AiAgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GuardrailType" AS ENUM ('PROMPT_INJECTION', 'PII', 'TOXICITY', 'JAILBREAK', 'OFF_TOPIC');

-- CreateEnum
CREATE TYPE "GuardrailSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "GuardrailAction" AS ENUM ('BLOCKED', 'MODIFIED', 'LOGGED');

-- CreateEnum
CREATE TYPE "FactValueType" AS ENUM ('TEXT', 'NUMBER', 'MONEY', 'PERCENT', 'DATE', 'BOOLEAN', 'URL', 'ENTITY_REF', 'LIST');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('ACTIVE', 'DISPUTED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "MentionKind" AS ENUM ('BOUND', 'DETECTED');

-- CreateEnum
CREATE TYPE "MentionState" AS ENUM ('IN_SYNC', 'STALE', 'CONFLICT', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FactSourceKind" AS ENUM ('MANUAL', 'URL', 'API', 'COLLECTION', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "FactChangeOrigin" AS ENUM ('USER', 'AGENT', 'SENTINEL', 'IMPORT');

-- CreateEnum
CREATE TYPE "BranchStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'MERGED', 'CLOSED', 'CONFLICTED');

-- CreateEnum
CREATE TYPE "BranchChangeOp" AS ENUM ('UPSERT', 'DELETE');

-- CreateEnum
CREATE TYPE "BranchChangeStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "phone" TEXT,
    "emailVerified" TIMESTAMP(3),
    "emailVerificationToken" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "lastLoginAt" TIMESTAMP(3),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "preferredAiModel" TEXT,
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "TenantPlan" NOT NULL DEFAULT 'FREE',
    "isolation" "TenantIsolation" NOT NULL DEFAULT 'SHARED',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "billingCustomerId" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "quota" JSONB NOT NULL DEFAULT '{}',
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_members" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'VIEWER',
    "invitedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'EDITOR',
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "isAgentKey" BOOLEAN NOT NULL DEFAULT false,
    "rateLimit" INTEGER,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "internalDomain" TEXT NOT NULL,
    "description" TEXT,
    "favicon" TEXT,
    "logo" TEXT,
    "theme" JSONB NOT NULL DEFAULT '{}',
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "locales" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "seoDefaults" JSONB NOT NULL DEFAULT '{}',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "fullPath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "seo" JSONB NOT NULL DEFAULT '{}',
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "translationGroupId" TEXT,
    "templateId" TEXT,
    "analytics" JSONB NOT NULL DEFAULT '{}',
    "qualityScore" DOUBLE PRECISION,
    "readabilityScore" DOUBLE PRECISION,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "seo" JSONB NOT NULL DEFAULT '{}',
    "comment" TEXT,
    "aiDiff" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "schema" JSONB NOT NULL,
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT NOT NULL,
    "isCore" BOOLEAN NOT NULL DEFAULT true,
    "isContainer" BOOLEAN NOT NULL DEFAULT false,
    "allowedChildren" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiGeneratable" BOOLEAN NOT NULL DEFAULT true,
    "pluginId" TEXT,
    "rendererKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "schema" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "isSingleton" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "translationGroupId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "qualityScore" DOUBLE PRECISION,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "comment" TEXT,
    "aiDiff" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entry_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "cdnUrl" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration" DOUBLE PRECISION,
    "alt" TEXT,
    "altGenerated" BOOLEAN NOT NULL DEFAULT false,
    "caption" TEXT,
    "title" TEXT,
    "folder" TEXT NOT NULL DEFAULT '/',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "variants" JSONB NOT NULL DEFAULT '{}',
    "aiMetadata" JSONB NOT NULL DEFAULT '{}',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggeredAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "notificationEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookUrl" TEXT,
    "successMessage" TEXT,
    "redirectUrl" TEXT,
    "aiSettings" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'NEW',
    "spamScore" DOUBLE PRECISION,
    "aiClassification" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_tests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variants" JSONB NOT NULL,
    "status" "AbTestStatus" NOT NULL DEFAULT 'DRAFT',
    "trafficAllocation" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "goalMetric" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "winnerVariantId" TEXT,
    "aiRecommendation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ab_test_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ab_test_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "pageId" TEXT,
    "event" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "referrer" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id","createdAt")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "aiInvolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id","createdAt")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_publishes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "ScheduledAction" NOT NULL DEFAULT 'PUBLISH',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_publishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "author" TEXT,
    "manifest" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_instances" (
    "id" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 8192,
    "inputPricePer1M" DECIMAL(10,4) NOT NULL,
    "outputPricePer1M" DECIMAL(10,4) NOT NULL,
    "capabilities" TEXT[],
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "embeddingDims" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "feature" "AiFeature" NOT NULL,
    "modelId" TEXT,
    "modelKey" TEXT NOT NULL,
    "promptId" TEXT,
    "traceId" TEXT,
    "promptText" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "responseText" TEXT,
    "responseMetadata" JSONB NOT NULL DEFAULT '{}',
    "relatedEntityType" "ContentEntityType",
    "relatedEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "template" TEXT NOT NULL,
    "system" TEXT,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "fewShotExamples" JSONB NOT NULL DEFAULT '[]',
    "guardrails" JSONB NOT NULL DEFAULT '{}',
    "modelKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompt_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "tokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(14,6) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "feedbackScore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prompt_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AiAgentType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "systemPrompt" TEXT NOT NULL,
    "tools" TEXT[],
    "modelId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_runs" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "parentRunId" TEXT,
    "input" JSONB NOT NULL,
    "status" "AiAgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "state" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_steps" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "node" TEXT,
    "toolName" TEXT,
    "toolInput" JSONB,
    "toolOutput" JSONB,
    "llmResponse" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_vector_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "locale" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embeddingModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_vector_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_semantic_cache" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "queryText" TEXT NOT NULL,
    "responseText" TEXT NOT NULL,
    "embedding" vector(1536),
    "modelKey" TEXT NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_semantic_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "userId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_guardrail_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "generationId" TEXT,
    "type" "GuardrailType" NOT NULL,
    "severity" "GuardrailSeverity" NOT NULL,
    "action" "GuardrailAction" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_guardrail_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kg_entities" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "type" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "kg_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "key" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "valueType" "FactValueType" NOT NULL,
    "value" JSONB NOT NULL,
    "displayValue" TEXT NOT NULL,
    "unit" TEXT,
    "locale" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'ACTIVE',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceId" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "displayValue" TEXT NOT NULL,
    "origin" "FactChangeOrigin" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "agentRunId" TEXT,
    "branchId" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_mentions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "factId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "blockId" TEXT,
    "fieldPath" TEXT NOT NULL,
    "anchor" JSONB NOT NULL,
    "surfaceText" TEXT NOT NULL,
    "observedValue" JSONB,
    "kind" "MentionKind" NOT NULL,
    "state" "MentionState" NOT NULL DEFAULT 'IN_SYNC',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "factVersionSeen" INTEGER NOT NULL,
    "detectedByGenerationId" TEXT,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fact_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_relations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "factId" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_sources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "FactSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "uri" TEXT,
    "selector" JSONB NOT NULL DEFAULT '{}',
    "collectionId" TEXT,
    "checkIntervalSec" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "lastHash" TEXT,
    "lastValue" JSONB,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fact_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_branches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "BranchStatus" NOT NULL DEFAULT 'OPEN',
    "baseSnapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentRunId" TEXT,
    "aiSummary" JSONB,
    "createdById" TEXT,
    "mergedById" TEXT,
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_changes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "entityType" "ContentEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "op" "BranchChangeOp" NOT NULL DEFAULT 'UPSERT',
    "baseVersion" INTEGER NOT NULL,
    "patch" JSONB NOT NULL,
    "aiExplanation" JSONB,
    "status" "BranchChangeStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_emailVerificationToken_key" ON "users"("emailVerificationToken");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_billingCustomerId_key" ON "tenants"("billingCustomerId");

-- CreateIndex
CREATE INDEX "tenant_members_userId_idx" ON "tenant_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_members_tenantId_userId_key" ON "tenant_members"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_tenantId_email_idx" ON "invitations"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_tenantId_idx" ON "api_keys"("tenantId");

-- CreateIndex
CREATE INDEX "api_keys_keyPrefix_idx" ON "api_keys"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "sites_internalDomain_key" ON "sites"("internalDomain");

-- CreateIndex
CREATE INDEX "sites_tenantId_idx" ON "sites"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenantId_slug_key" ON "sites"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "pages_siteId_fullPath_locale_idx" ON "pages"("siteId", "fullPath", "locale");

-- CreateIndex
CREATE INDEX "pages_tenantId_siteId_status_idx" ON "pages"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "pages_siteId_parentId_idx" ON "pages"("siteId", "parentId");

-- CreateIndex
CREATE INDEX "pages_translationGroupId_idx" ON "pages"("translationGroupId");

-- CreateIndex
CREATE INDEX "pages_scheduledAt_idx" ON "pages"("scheduledAt");

-- CreateIndex
CREATE INDEX "page_versions_tenantId_idx" ON "page_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "page_versions_pageId_version_key" ON "page_versions"("pageId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "blocks_type_key" ON "blocks"("type");

-- CreateIndex
CREATE INDEX "blocks_category_idx" ON "blocks"("category");

-- CreateIndex
CREATE INDEX "collections_tenantId_idx" ON "collections"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "collections_siteId_slug_key" ON "collections"("siteId", "slug");

-- CreateIndex
CREATE INDEX "entries_collectionId_slug_locale_idx" ON "entries"("collectionId", "slug", "locale");

-- CreateIndex
CREATE INDEX "entries_tenantId_collectionId_status_idx" ON "entries"("tenantId", "collectionId", "status");

-- CreateIndex
CREATE INDEX "entries_translationGroupId_idx" ON "entries"("translationGroupId");

-- CreateIndex
CREATE INDEX "entry_versions_tenantId_idx" ON "entry_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "entry_versions_entryId_version_key" ON "entry_versions"("entryId", "version");

-- CreateIndex
CREATE INDEX "media_tenantId_siteId_folder_idx" ON "media"("tenantId", "siteId", "folder");

-- CreateIndex
CREATE INDEX "media_siteId_contentHash_idx" ON "media"("siteId", "contentHash");

-- CreateIndex
CREATE INDEX "media_tags_idx" ON "media" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "webhooks_tenantId_isActive_idx" ON "webhooks"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_createdAt_idx" ON "webhook_deliveries"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextRetryAt_idx" ON "webhook_deliveries"("status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "forms_tenantId_idx" ON "forms"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "forms_siteId_slug_key" ON "forms"("siteId", "slug");

-- CreateIndex
CREATE INDEX "form_submissions_formId_status_createdAt_idx" ON "form_submissions"("formId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "form_submissions_tenantId_idx" ON "form_submissions"("tenantId");

-- CreateIndex
CREATE INDEX "ab_tests_tenantId_status_idx" ON "ab_tests"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ab_tests_pageId_idx" ON "ab_tests"("pageId");

-- CreateIndex
CREATE INDEX "ab_test_events_testId_variantId_event_idx" ON "ab_test_events"("testId", "variantId", "event");

-- CreateIndex
CREATE INDEX "analytics_events_siteId_createdAt_idx" ON "analytics_events"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_pageId_createdAt_idx" ON "analytics_events"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "scheduled_publishes_status_scheduledAt_idx" ON "scheduled_publishes"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "scheduled_publishes_tenantId_entityType_entityId_idx" ON "scheduled_publishes"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "plugins_name_key" ON "plugins"("name");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_instances_pluginId_tenantId_key" ON "plugin_instances"("pluginId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_name_key" ON "ai_providers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_providerId_name_key" ON "ai_models"("providerId", "name");

-- CreateIndex
CREATE INDEX "ai_generations_tenantId_createdAt_idx" ON "ai_generations"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_generations_tenantId_feature_createdAt_idx" ON "ai_generations"("tenantId", "feature", "createdAt");

-- CreateIndex
CREATE INDEX "ai_generations_relatedEntityType_relatedEntityId_idx" ON "ai_generations"("relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE INDEX "ai_prompts_name_isActive_idx" ON "ai_prompts"("name", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompts_tenantId_name_version_key" ON "ai_prompts"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "ai_prompt_runs_promptId_createdAt_idx" ON "ai_prompt_runs"("promptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agents_tenantId_name_key" ON "ai_agents"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ai_agent_runs_tenantId_status_createdAt_idx" ON "ai_agent_runs"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_agent_runs_parentRunId_idx" ON "ai_agent_runs"("parentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_steps_runId_stepNumber_key" ON "ai_agent_steps"("runId", "stepNumber");

-- CreateIndex
CREATE INDEX "ai_vector_documents_tenantId_siteId_idx" ON "ai_vector_documents"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_vector_documents_entityType_entityId_chunkIndex_embeddin_key" ON "ai_vector_documents"("entityType", "entityId", "chunkIndex", "embeddingModel");

-- CreateIndex
CREATE INDEX "ai_semantic_cache_expiresAt_idx" ON "ai_semantic_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_semantic_cache_tenantId_queryHash_modelKey_key" ON "ai_semantic_cache"("tenantId", "queryHash", "modelKey");

-- CreateIndex
CREATE INDEX "ai_feedback_generationId_idx" ON "ai_feedback"("generationId");

-- CreateIndex
CREATE INDEX "ai_guardrail_events_tenantId_createdAt_idx" ON "ai_guardrail_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_guardrail_events_type_severity_idx" ON "ai_guardrail_events"("type", "severity");

-- CreateIndex
CREATE INDEX "kg_entities_aliases_idx" ON "kg_entities" USING GIN ("aliases");

-- CreateIndex
CREATE UNIQUE INDEX "kg_entities_tenantId_type_canonicalName_key" ON "kg_entities"("tenantId", "type", "canonicalName");

-- CreateIndex
CREATE INDEX "facts_tenantId_subjectId_predicate_idx" ON "facts"("tenantId", "subjectId", "predicate");

-- CreateIndex
CREATE INDEX "facts_tenantId_status_idx" ON "facts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "facts_expiresAt_idx" ON "facts"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "facts_tenantId_key_key" ON "facts"("tenantId", "key");

-- CreateIndex
CREATE INDEX "fact_versions_tenantId_createdAt_idx" ON "fact_versions"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "fact_versions_factId_version_key" ON "fact_versions"("factId", "version");

-- CreateIndex
CREATE INDEX "fact_mentions_tenantId_factId_state_idx" ON "fact_mentions"("tenantId", "factId", "state");

-- CreateIndex
CREATE INDEX "fact_mentions_tenantId_entityType_entityId_idx" ON "fact_mentions"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "fact_mentions_tenantId_state_idx" ON "fact_mentions"("tenantId", "state");

-- CreateIndex
CREATE INDEX "fact_relations_tenantId_toEntityId_idx" ON "fact_relations"("tenantId", "toEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "fact_relations_fromEntityId_toEntityId_predicate_key" ON "fact_relations"("fromEntityId", "toEntityId", "predicate");

-- CreateIndex
CREATE INDEX "fact_sources_tenantId_kind_idx" ON "fact_sources"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "fact_sources_lastCheckedAt_idx" ON "fact_sources"("lastCheckedAt");

-- CreateIndex
CREATE INDEX "content_branches_tenantId_status_idx" ON "content_branches"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_branches_siteId_name_key" ON "content_branches"("siteId", "name");

-- CreateIndex
CREATE INDEX "branch_changes_tenantId_idx" ON "branch_changes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_changes_branchId_entityType_entityId_key" ON "branch_changes"("branchId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_occurredAt_idx" ON "outbox_events"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_idx" ON "outbox_events"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_versions" ADD CONSTRAINT "entry_versions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_versions" ADD CONSTRAINT "entry_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms" ADD CONSTRAINT "forms_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_tests" ADD CONSTRAINT "ab_tests_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ab_test_events" ADD CONSTRAINT "ab_test_events_testId_fkey" FOREIGN KEY ("testId") REFERENCES "ab_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "ai_prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_prompt_runs" ADD CONSTRAINT "ai_prompt_runs_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "ai_prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ai_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_runs" ADD CONSTRAINT "ai_agent_runs_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "ai_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_steps" ADD CONSTRAINT "ai_agent_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_vector_documents" ADD CONSTRAINT "ai_vector_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_semantic_cache" ADD CONSTRAINT "ai_semantic_cache_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ai_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_guardrail_events" ADD CONSTRAINT "ai_guardrail_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_guardrail_events" ADD CONSTRAINT "ai_guardrail_events_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "ai_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entities" ADD CONSTRAINT "kg_entities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kg_entities" ADD CONSTRAINT "kg_entities_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "fact_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_factId_fkey" FOREIGN KEY ("factId") REFERENCES "facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_versions" ADD CONSTRAINT "fact_versions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "content_branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_mentions" ADD CONSTRAINT "fact_mentions_factId_fkey" FOREIGN KEY ("factId") REFERENCES "facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_relations" ADD CONSTRAINT "fact_relations_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_relations" ADD CONSTRAINT "fact_relations_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "kg_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_relations" ADD CONSTRAINT "fact_relations_factId_fkey" FOREIGN KEY ("factId") REFERENCES "facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_sources" ADD CONSTRAINT "fact_sources_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_branches" ADD CONSTRAINT "content_branches_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_branches" ADD CONSTRAINT "content_branches_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "ai_agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_branches" ADD CONSTRAINT "content_branches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_branches" ADD CONSTRAINT "content_branches_mergedById_fkey" FOREIGN KEY ("mergedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_changes" ADD CONSTRAINT "branch_changes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "content_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

