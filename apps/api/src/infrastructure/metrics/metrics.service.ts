import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus registry. AI metrics are labelled by feature/model/status only — never by tenant:
 * tenant-level cost lives in ai_generations and Langfuse, and a tenant label would explode
 * series cardinality at thousands of tenants.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly aiGenerations = new Counter({
    name: 'canon_ai_generations_total',
    help: 'AI gateway calls by outcome',
    labelNames: ['feature', 'model', 'status', 'cache', 'fallback'] as const,
    registers: [this.registry],
  });

  readonly aiLatency = new Histogram({
    name: 'canon_ai_latency_ms',
    help: 'AI gateway end-to-end latency',
    labelNames: ['feature', 'model'] as const,
    buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000],
    registers: [this.registry],
  });

  readonly aiCostMicroUsd = new Counter({
    name: 'canon_ai_cost_micro_usd_total',
    help: 'AI spend in micro-USD',
    labelNames: ['feature', 'model'] as const,
    registers: [this.registry],
  });

  readonly aiTokens = new Counter({
    name: 'canon_ai_tokens_total',
    help: 'AI tokens by direction',
    labelNames: ['model', 'direction'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
