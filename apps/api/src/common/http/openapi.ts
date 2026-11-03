import { RequestMethod, VERSION_NEUTRAL, type INestApplication } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodBody } from './zod-body.pipe';

type JsonSchema = Record<string, unknown>;
type Operation = {
  requestBody?: unknown;
  parameters?: { name: string; in: string; required?: boolean; schema?: unknown; description?: string }[];
};

const VERBS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/**
 * The OpenAPI document, with request bodies and query parameters filled in from the Zod schemas
 * the routes validate with (`@Body(new ZodBody(schema))`). Swagger's decorators never see those
 * schemas, so without this every body would be undocumented — and the SDK untyped.
 */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Canon CMS API')
    .setDescription('AI-native headless CMS — REST v1')
    .setVersion('0.3.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  for (const route of zodRoutes(app)) {
    const op = (doc.paths[route.path] as Record<string, Operation> | undefined)?.[route.verb];
    if (!op) continue;
    if (route.body)
      op.requestBody = {
        required: !route.body.optional,
        content: { 'application/json': { schema: route.body.schema } },
      };
    if (route.query) {
      const props = (route.query.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((route.query.required as string[] | undefined) ?? []);
      const fromZod = Object.entries(props).map(([name, schema]) => ({
        name,
        in: 'query',
        required: required.has(name),
        schema,
        ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
      }));
      op.parameters = [
        ...(op.parameters ?? []).filter((p) => p.in !== 'query' || !props[p.name]),
        ...fromZod,
      ];
    }
  }
  // Responses are not described per route; mark JSON 2xx bodies as "any JSON" so generated
  // clients expose `data` instead of treating it as absent.
  for (const item of Object.values(doc.paths)) {
    for (const op of Object.values(
      item as Record<string, { responses?: Record<string, { content?: unknown }> }>,
    )) {
      for (const [code, res] of Object.entries(op?.responses ?? {})) {
        if (/^2\d\d$/.test(code) && code !== '204' && !res.content)
          res.content = { 'application/json': { schema: {} } };
      }
    }
  }
  return doc;
}

function toJson(schema: z.ZodType): JsonSchema {
  // io:'input' describes what clients send (defaults optional); unrepresentable types become {}.
  const out = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'openapi-3.0',
  }) as JsonSchema;
  delete out.$schema;
  return out;
}

function* zodRoutes(
  app: INestApplication,
): Generator<{
  path: string;
  verb: string;
  body?: { schema: JsonSchema; optional: boolean };
  query?: JsonSchema;
}> {
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: unknown[]) => object) | undefined;
      if (!ctrl?.prototype) continue;
      const base =
        [Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[] | undefined].flat()[0] ?? '';
      const ctrlVersion = Reflect.getMetadata(VERSION_METADATA, ctrl) as unknown;
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        const verb = method === undefined ? undefined : VERBS[method];
        if (!verb) continue;
        const sub =
          [Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined].flat()[0] ?? '';
        const version = (Reflect.getMetadata(VERSION_METADATA, handler) as unknown) ?? ctrlVersion ?? '1';
        const prefix = version === VERSION_NEUTRAL ? '' : `/v${String(version)}`;
        const path =
          `${prefix}/${[base, sub].filter(Boolean).join('/')}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, '')
            .replace(/:(\w+)/g, '{$1}') || '/';
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {}) as Record<
          string,
          { pipes?: unknown[] }
        >;
        let body: { schema: JsonSchema; optional: boolean } | undefined;
        let query: JsonSchema | undefined;
        for (const [key, arg] of Object.entries(args)) {
          const pipe = arg.pipes?.find((p): p is ZodBody<z.ZodType> => p instanceof ZodBody);
          if (!pipe) continue;
          const type = Number(key.split(':')[0]);
          if (type === RouteParamtypes.BODY)
            body = { schema: toJson(pipe.schema), optional: pipe.schema.safeParse(undefined).success };
          else if (type === RouteParamtypes.QUERY) query = toJson(pipe.schema);
        }
        if (body || query) yield { path, verb, body, query };
      }
    }
  }
}
