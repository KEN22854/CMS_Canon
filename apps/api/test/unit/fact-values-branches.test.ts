import { describe, expect, it } from 'vitest';
import { detectSpans, deterministicCheck, formatFactValue, literalSubstitution, numberOf, parseLooseNumber, sameValue, type FactLike } from '../../src/modules/canon/fact-values';

const fact = (over: Partial<FactLike>): FactLike => ({ id: 'f', key: 'k', valueType: 'TEXT', value: {}, displayValue: '', subjectNames: [], ...over });

describe('numberOf', () => {
  it('reads plain numbers, {amount}, {value} and loose strings', () => {
    expect(numberOf(7)).toBe(7);
    expect(numberOf({ amount: 49 })).toBe(49);
    expect(numberOf({ value: 99.5 })).toBe(99.5);
    expect(numberOf('1 234,5')).toBe(1234.5);
  });

  it('rejects non-finite and non-numeric input', () => {
    expect(numberOf(Number.NaN)).toBeNull();
    expect(numberOf(Infinity)).toBeNull();
    expect(numberOf({ amount: Infinity })).toBeNull();
    expect(numberOf({ amount: '49' })).toBeNull();
    expect(numberOf({})).toBeNull();
    expect(numberOf('free')).toBeNull();
    expect(numberOf(null)).toBeNull();
    expect(numberOf(true)).toBeNull();
  });
});

describe('parseLooseNumber', () => {
  it('handles spaces of every kind used as thousands separators', () => {
    expect(parseLooseNumber('1 234')).toBe(1234);
    expect(parseLooseNumber('1 234')).toBe(1234);
    expect(parseLooseNumber('1 234')).toBe(1234);
  });

  it('keeps signs and strips currency and words', () => {
    expect(parseLooseNumber('-5')).toBe(-5);
    expect(parseLooseNumber('$1,299.99/mo')).toBe(1299.99);
    expect(parseLooseNumber('€ 49,90')).toBe(49.9);
  });

  it('returns null without digits or when the result is not a number', () => {
    expect(parseLooseNumber('—')).toBeNull();
    expect(parseLooseNumber('1-2-3')).toBeNull();
  });
});

describe('formatFactValue', () => {
  it('formats money with known symbols, other codes, periods and missing amounts', () => {
    expect(formatFactValue('MONEY', { amount: 990, currency: 'rub' })).toBe('₽990');
    expect(formatFactValue('MONEY', { amount: 10.5 })).toBe('$10.5');
    expect(formatFactValue('MONEY', { amount: 10, currency: 'SEK', period: 'year' })).toBe('10 SEK/year');
    expect(formatFactValue('MONEY', { amount: 10, period: '' })).toBe('$10');
    expect(formatFactValue('MONEY', { currency: 'USD' })).toBe('');
  });

  it('formats numbers with and without unit, percentages, and empty values', () => {
    expect(formatFactValue('NUMBER', { value: 1.25 })).toBe('1.25');
    expect(formatFactValue('NUMBER', 3, null)).toBe('3');
    expect(formatFactValue('NUMBER', {})).toBe('');
    expect(formatFactValue('PERCENT', { value: 12.5 })).toBe('12.5%');
    expect(formatFactValue('PERCENT', null)).toBe('');
  });

  it('formats dates, booleans, urls, lists and text in both shapes', () => {
    expect(formatFactValue('DATE', { date: '2026-12-01' })).toBe('2026-12-01');
    expect(formatFactValue('DATE', '2026-12-01')).toBe('2026-12-01');
    expect(formatFactValue('DATE', 5)).toBe('');
    expect(formatFactValue('BOOLEAN', { value: false })).toBe('no');
    expect(formatFactValue('BOOLEAN', { value: true })).toBe('yes');
    expect(formatFactValue('BOOLEAN', 1)).toBe('yes');
    expect(formatFactValue('URL', { url: 'https://canon.example' })).toBe('https://canon.example');
    expect(formatFactValue('URL', {})).toBe('');
    expect(formatFactValue('LIST', { items: ['SSO', 'SCIM', 3] })).toBe('SSO, SCIM, 3');
    expect(formatFactValue('LIST', { items: 'nope' })).toBe('');
    expect(formatFactValue('TEXT', { text: 'Berlin' })).toBe('Berlin');
    expect(formatFactValue('TEXT', 'Berlin')).toBe('Berlin');
    expect(formatFactValue('ENTITY_REF', 42)).toBe('');
  });
});

describe('sameValue', () => {
  it('compares numbers and percentages numerically, unknown on missing numbers', () => {
    expect(sameValue('NUMBER', { value: 120 }, '120')).toBe(true);
    expect(sameValue('PERCENT', { value: 99.9 }, { value: 99.95 })).toBe(false);
    expect(sameValue('NUMBER', { value: 1 }, 'many')).toBe(false);
  });

  it('ignores currency when either side does not state one', () => {
    expect(sameValue('MONEY', { amount: 49, currency: 'USD' }, 49)).toBe(true);
    expect(sameValue('MONEY', { amount: 49 }, { amount: 49, currency: 'EUR' })).toBe(true);
    expect(sameValue('MONEY', { amount: 49, currency: 'usd' }, { amount: 49, currency: 'USD' })).toBe(true);
  });

  it('compares other types by their display form, never matching empty values', () => {
    expect(sameValue('TEXT', { text: 'Berlin' }, 'berlin ')).toBe(true);
    expect(sameValue('URL', { url: 'https://a.example' }, { url: 'https://b.example' })).toBe(false);
    expect(sameValue('TEXT', {}, {})).toBe(false);
  });
});

describe('detectSpans', () => {
  const pro = fact({ id: 'pro', valueType: 'MONEY', value: { amount: 49, currency: 'USD' }, displayValue: '$49/month', subjectNames: ['Pro plan', 'Pro'] });
  const team = fact({ id: 'team', valueType: 'MONEY', value: { amount: 99, currency: 'USD' }, displayValue: '$99/month', subjectNames: ['Team plan'] });

  it('skips display values too short to be meaningful', () => {
    expect(detectSpans('a b c', [fact({ id: 'x', displayValue: 'a' })])).toEqual([]);
  });

  it('does not match inside words or longer numbers', () => {
    expect(detectSpans('ABC$49/month and $49/monthly', [pro]).filter((s) => s.confidence === 0.95)).toHaveLength(1);
  });

  it('reads amounts with the symbol after the number and as an ISO code', () => {
    const spans = detectSpans('The Pro plan is 39 EUR. The Pro plan is now 49 usd.', [pro]);
    expect(spans.map((s) => [s.surfaceText, s.inSync])).toEqual([
      ['39 EUR', false],
      ['49 usd', true],
    ]);
  });

  it('leaves sentences naming two priced subjects to the model', () => {
    expect(detectSpans('The Pro plan is $39 and the Team plan is $99.', [pro, team]).filter((s) => s.confidence === 0.7)).toEqual([]);
  });

  it('ignores subjects that have several money facts', () => {
    const proYear = fact({ ...pro, id: 'pro-year', displayValue: '$490/year' });
    expect(detectSpans('The Pro plan costs $39.', [pro, proYear])).toEqual([]);
  });
});

describe('literalSubstitution and deterministicCheck', () => {
  const next = { value: { amount: 59 }, displayValue: '$59/month' };

  it('swaps the observed number when the old one is not in the span, and gives up on prose', () => {
    expect(literalSubstitution('only 39 dollars', '$49/month', { amount: 49 }, next, { amount: 39 })).toBe('only 59 dollars');
    expect(literalSubstitution('under fifty dollars', '$49/month', { amount: 49 }, next)).toBeNull();
    expect(literalSubstitution('$49', '$49/month', { amount: 49 }, { value: { text: 'x' }, displayValue: 'x' })).toBeNull();
  });

  it('flags a rewrite that keeps the old number or never states the new value', () => {
    expect(deterministicCheck('Now $59 instead of 49.', '$49/month', { valueType: 'MONEY', ...next }, { amount: 49 })).toEqual({ pass: false, issues: ['Still contains the old number (49)'] });
    expect(deterministicCheck('A great price.', '', { valueType: 'MONEY', ...next }, { amount: 49 }).issues).toEqual(['Does not state the new value ($59/month)']);
    expect(deterministicCheck('Only $59/month.', '$49/month', { valueType: 'MONEY', ...next }, { amount: 49 })).toEqual({ pass: true, issues: [] });
  });
});
