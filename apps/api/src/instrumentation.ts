import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Must be imported before anything else in main.ts: auto-instrumentation patches modules
 * (http, express, pg, ioredis) at require time, so late imports would go untraced.
 * Disabled unless an OTLP endpoint is configured — no exporter retries spamming dev logs.
 */
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const otelSdk = endpoint
  ? new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'canon-api',
      traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are pure noise for an API and dominate trace volume.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    })
  : undefined;

otelSdk?.start();
