import { AI_ERROR_CODES, AiGatewayError } from '../domain/errors';
import type { CompletionRequest, ModelCapability, ModelInfo, ModelKey, ProviderId } from '../domain/types';
import type { ModelCatalog, TenantAiPolicy } from '../ports';

export function requiredCapabilities(req: Pick<CompletionRequest, 'messages' | 'responseFormat'>): ModelCapability[] {
  const caps: ModelCapability[] = ['text'];
  const hasImage = req.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'));
  if (hasImage) caps.push('vision');
  if (req.responseFormat === 'json') caps.push('json-mode');
  return caps;
}

/**
 * Ordered list of models to try. Order: explicit model → tenant default → tenant fallbacks.
 * Filtered by tenant allow-list, capabilities and configured providers, so a vision request
 * never falls back to a text-only local model and a tenant never escapes its model tier.
 */
export function buildCandidateChain(
  req: CompletionRequest,
  policy: TenantAiPolicy,
  catalog: ModelCatalog,
  availableProviders: ReadonlySet<ProviderId>,
): ModelInfo[] {
  const allowed = new Set(policy.allowedModels);
  const tiers = policy.allowedTiers ? new Set(policy.allowedTiers) : undefined;
  const isAllowed = (key: ModelKey) => {
    if (allowed.size > 0 && !allowed.has(key)) return false;
    const tier = catalog.get(key)?.tier;
    return !tiers || (tier !== undefined && tiers.has(tier));
  };

  if (req.model && !isAllowed(req.model)) {
    throw new AiGatewayError(AI_ERROR_CODES.MODEL_NOT_ALLOWED, `Model ${req.model} is not allowed on this plan or tenant policy`);
  }

  const ordered: ModelKey[] = req.model
    ? req.strictModel
      ? [req.model]
      : [req.model, policy.defaultModel, ...policy.fallbackModels]
    : [policy.defaultModel, ...policy.fallbackModels];

  const caps = requiredCapabilities(req);
  const seen = new Set<ModelKey>();
  const chain: ModelInfo[] = [];
  for (const key of ordered) {
    if (seen.has(key)) continue;
    seen.add(key);
    const model = catalog.get(key);
    if (!model || !isAllowed(key) || !availableProviders.has(model.provider)) continue;
    if (!caps.every((c) => model.capabilities.includes(c))) continue;
    chain.push(model);
  }

  if (chain.length === 0) {
    throw new AiGatewayError(
      AI_ERROR_CODES.NO_CANDIDATE_MODEL,
      `No configured model satisfies capabilities [${caps.join(', ')}]`,
      { requested: req.model, capabilities: caps },
    );
  }
  return chain;
}
