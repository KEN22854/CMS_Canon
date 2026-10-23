-- Phase 3: AI page/block generation is metered and traced as its own feature.
ALTER TYPE "AiFeature" ADD VALUE IF NOT EXISTS 'LAYOUT';
