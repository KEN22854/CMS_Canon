import { AbilityBuilder, Ability, fieldPatternMatcher, mongoQueryMatcher, type MongoQuery } from '@casl/ability';
import type { RequestPrincipal } from './principal';

export const ACTIONS = ['manage', 'create', 'read', 'update', 'delete', 'publish', 'invite', 'invoke'] as const;
export type Action = (typeof ACTIONS)[number];

export const SUBJECTS = [
  'Tenant',
  'Member',
  'Invitation',
  'ApiKey',
  'Billing',
  'AuditLog',
  'Site',
  'Page',
  'Entry',
  'Collection',
  'Media',
  'Form',
  'AbTest',
  'Analytics',
  'Ai',
  'AiUsage',
  'AiAgent',
  'AiPrompt',
  'Fact',
  'Branch',
  'Webhook',
  'Plugin',
  'all',
] as const;
export type SubjectName = (typeof SUBJECTS)[number];

/**
 * Ability + Mongo matcher (what createMongoAbility builds) with conditions typed as plain
 * MongoQuery: our subjects are string-tagged (subject('Page', row)), so CASL cannot infer field
 * types from classes, and its inferred condition type would collapse to MongoQuery<never>.
 */
export type AppAbility = Ability<[Action, SubjectName | object], MongoQuery>;

const CONTENT: SubjectName[] = ['Site', 'Page', 'Entry', 'Collection', 'Media', 'Form', 'AbTest', 'Fact', 'Branch'];
const AUTHORED: SubjectName[] = ['Page', 'Entry', 'Media', 'Fact', 'Branch'];

/**
 * API-key scopes → abilities. Scopes are coarse on purpose (what integrators reason about);
 * the mapping is the single place that translates them to the role model.
 */
export const API_KEY_SCOPES = {
  'content:read': [['read', CONTENT]],
  'content:write': [['create', AUTHORED], ['update', AUTHORED]],
  'content:publish': [['publish', ['Page', 'Entry']]],
  'media:write': [['create', ['Media']], ['update', ['Media']]],
  'ai:invoke': [['invoke', ['Ai']]],
  'ai:usage:read': [['read', ['AiUsage']]],
  'canon:read': [['read', ['Fact', 'Branch']]],
  'canon:write': [['create', ['Fact', 'Branch']], ['update', ['Fact', 'Branch']]],
  'analytics:read': [['read', ['Analytics']]],
} as const satisfies Record<string, ReadonlyArray<readonly [Action, readonly SubjectName[]]>>;

export type ApiKeyScope = keyof typeof API_KEY_SCOPES;
export const API_KEY_SCOPE_NAMES = Object.keys(API_KEY_SCOPES) as ApiKeyScope[];

/**
 * Role matrix. Every tenant rule carries `{ tenantId }` so an object loaded from another tenant
 * (e.g. via a bug in a repository filter) still fails the instance check — the third line of
 * defence after repository filters and RLS.
 */
export function defineAbilityFor(p: RequestPrincipal): AppAbility {
  const { can, cannot, build: buildRaw } = new AbilityBuilder<AppAbility>(Ability);
  const build = () => buildRaw({ conditionsMatcher: mongoQueryMatcher, fieldMatcher: fieldPatternMatcher });

  if (p.systemRole === 'SUPER_ADMIN' && p.actorType === 'user') {
    can('manage', 'all');
    return build();
  }

  const t = p.tenantId;
  if (!t) return build();
  const own: MongoQuery = { tenantId: t };
  const ownerRows: MongoQuery = { role: 'OWNER' };
  const authoredByMe: MongoQuery = { tenantId: t, createdById: p.userId ?? '__none__' };

  if (p.actorType !== 'user') {
    for (const scope of p.scopes ?? []) {
      const grants = API_KEY_SCOPES[scope as ApiKeyScope];
      if (!grants) continue;
      for (const [action, subjects] of grants) can(action, [...subjects], own);
    }
    return build();
  }

  switch (p.memberRole) {
    case 'OWNER':
      can('manage', 'all', own);
      break;
    case 'ADMIN':
      can('manage', 'all', own);
      // Ownership transfer, deletion and billing stay with owners.
      cannot('delete', 'Tenant');
      cannot('manage', 'Billing');
      cannot(['update', 'delete'], 'Member', ownerRows);
      cannot('invite', 'Member', ownerRows);
      break;
    case 'EDITOR':
      can(['create', 'read', 'update', 'delete', 'publish'], CONTENT, own);
      can('invoke', 'Ai', own);
      can('read', ['Tenant', 'Member', 'AiUsage', 'Analytics', 'AiAgent', 'AiPrompt'], own);
      break;
    case 'AUTHOR':
      can('read', CONTENT, own);
      can('create', AUTHORED, own);
      // Authors edit what they created; publishing goes through an editor.
      can(['update', 'delete'], AUTHORED, authoredByMe);
      can('invoke', 'Ai', own);
      can('read', ['Tenant', 'Member'], own);
      break;
    case 'VIEWER':
      can('read', [...CONTENT, 'Tenant', 'Member', 'Analytics'], own);
      break;
    default:
      break;
  }
  return build();
}
