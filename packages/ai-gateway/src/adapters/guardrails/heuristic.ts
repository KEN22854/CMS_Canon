import type { ChatMessage, ContentPart } from '../../domain/types';
import type { GuardrailFinding, GuardrailPolicy, GuardrailPort, InputInspection } from '../../ports';

/**
 * Zero-latency, zero-cost first line of defence. It is deliberately conservative (few patterns,
 * low false-positive rate); a model-based detector (Lakera / NeMo) plugs in behind the same port
 * for Enterprise tenants. Only user/assistant turns are scanned for injection — the system
 * prompt is ours, and flagging it would block every request.
 */

const INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; weight: number; label: string }> = [
  { re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?)\b/i, weight: 3, label: 'override-instructions' },
  { re: /\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system|hidden|initial)\s+(prompt|instructions?)\b/i, weight: 3, label: 'exfiltrate-system-prompt' },
  { re: /\byou are now\b|\bfrom now on,? you (are|will)\b/i, weight: 2, label: 'persona-hijack' },
  { re: /\b(developer|dan|jailbreak|god)\s+mode\b/i, weight: 3, label: 'jailbreak-mode' },
  { re: /<\/?(system|assistant|im_start|im_end)>|\[\/?INST\]/i, weight: 2, label: 'role-tag-injection' },
  { re: /\bdo not (tell|inform) the user\b/i, weight: 2, label: 'concealment' },
];

const BLOCK_SCORE = 3;

interface PiiRule {
  kind: string;
  re: RegExp;
  validate?: (match: string) => boolean;
}

const PII_RULES: readonly PiiRule[] = [
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'CARD', re: /\b(?:\d[ -]?){13,19}\b/g, validate: luhn },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g },
  { kind: 'PHONE', re: /(?<![\w$€£])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{2,4}(?:[\s.-]?\d{2})?\b/g },
];

export class HeuristicGuardrails implements GuardrailPort {
  async inspectInput(system: string | undefined, messages: ChatMessage[], policy: GuardrailPolicy): Promise<InputInspection> {
    const findings: GuardrailFinding[] = [];
    let score = 0;

    if (policy.promptInjection !== 'off') {
      for (const m of messages) {
        for (const text of textsOf(m)) {
          for (const p of INJECTION_PATTERNS) {
            if (p.re.test(text)) {
              score += p.weight;
              findings.push({ type: p.label === 'jailbreak-mode' ? 'JAILBREAK' : 'PROMPT_INJECTION', severity: p.weight >= 3 ? 'HIGH' : 'MEDIUM', detail: p.label });
            }
          }
        }
      }
    }

    const counters = new Map<string, number>();
    const redact = (text: string): string => redactPii(text, counters, findings);
    const redactedMessages = messages.map((m) => mapText(m, redact));
    const redactedSystem = system === undefined ? undefined : redact(system);

    return {
      findings,
      block: policy.promptInjection === 'block' && score >= BLOCK_SCORE,
      redactedSystem,
      redactedMessages,
    };
  }

  async inspectOutput(text: string, _policy: GuardrailPolicy): Promise<{ findings: GuardrailFinding[]; block: boolean }> {
    // System-prompt echo is the one output failure we can detect cheaply and always want to stop.
    const leaked = /\bmy (system )?instructions (are|say)\b/i.test(text);
    return leaked
      ? { findings: [{ type: 'PROMPT_INJECTION', severity: 'HIGH', detail: 'possible system-prompt disclosure' }], block: true }
      : { findings: [], block: false };
  }
}

function textsOf(m: ChatMessage): string[] {
  return typeof m.content === 'string' ? [m.content] : m.content.flatMap((p) => (p.type === 'text' ? [p.text] : []));
}

function mapText(m: ChatMessage, fn: (t: string) => string): ChatMessage {
  if (typeof m.content === 'string') return { role: m.role, content: fn(m.content) };
  return { role: m.role, content: m.content.map((p): ContentPart => (p.type === 'text' ? { type: 'text', text: fn(p.text) } : p)) };
}

/** Placeholders are numbered per kind so the model can still tell two different emails apart. */
function redactPii(text: string, counters: Map<string, number>, findings: GuardrailFinding[]): string {
  let out = text;
  for (const rule of PII_RULES) {
    out = out.replace(rule.re, (match) => {
      if (rule.validate && !rule.validate(match)) return match;
      const n = (counters.get(rule.kind) ?? 0) + 1;
      counters.set(rule.kind, n);
      findings.push({ type: 'PII', severity: rule.kind === 'CARD' || rule.kind === 'IBAN' ? 'HIGH' : 'LOW', detail: rule.kind });
      return `[${rule.kind}_${n}]`;
    });
  }
  return out;
}

function luhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
