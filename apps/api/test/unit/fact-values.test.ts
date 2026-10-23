import { describe, expect, it } from 'vitest';
import { detectSpans, deterministicCheck, formatFactValue, literalSubstitution, parseLooseNumber, sameValue, type FactLike } from '../../src/modules/canon/fact-values';

const price: FactLike = { id: 'f1', key: 'pro_plan.price', valueType: 'MONEY', value: { amount: 49, currency: 'USD', period: 'month' }, displayValue: '$49/month', subjectNames: ['Pro plan', 'Pro'] };
const integrations: FactLike = { id: 'f2', key: 'acme.integrations_count', valueType: 'NUMBER', value: { value: 120 }, displayValue: '120+', subjectNames: ['Acme'] };

describe('fact values', () => {
  it('formats typed values', () => {
    expect(formatFactValue('MONEY', { amount: 59, currency: 'USD', period: 'month' })).toBe('$59/month');
    expect(formatFactValue('MONEY', { amount: 19.9, currency: 'CHF' })).toBe('19.9 CHF');
    expect(formatFactValue('PERCENT', { value: 99.95 })).toBe('99.95%');
    expect(formatFactValue('NUMBER', { value: 10 }, 'seats')).toBe('10 seats');
  });

  it('parses loose numbers in several locales', () => {
    expect(parseLooseNumber('1,234.50')).toBe(1234.5);
    expect(parseLooseNumber('1.234,50')).toBe(1234.5);
    expect(parseLooseNumber('49')).toBe(49);
  });

  it('compares numerically and respects currencies', () => {
    expect(sameValue('MONEY', price.value, { amount: 49 })).toBe(true);
    expect(sameValue('MONEY', price.value, { amount: 39, currency: 'USD' })).toBe(false);
    expect(sameValue('MONEY', price.value, { amount: 49, currency: 'EUR' })).toBe(false);
  });
});

describe('deterministic detection', () => {
  it('finds verbatim display values, not inside larger numbers', () => {
    const spans = detectSpans('Connect 120+ tools. We had 1120+ requests.', [integrations]);
    expect(spans.map((s) => s.surfaceText)).toEqual(['120+']);
  });

  it('flags a conflicting price only in a sentence that names the subject', () => {
    const text = 'The Pro plan is just $39 per month. Get $10 off your first order.';
    const spans = detectSpans(text, [price]);
    expect(spans).toEqual([expect.objectContaining({ factId: 'f1', surfaceText: '$39', inSync: false, observedValue: { amount: 39, currency: 'USD' } })]);
    expect(detectSpans('Der Pro-Tarif kostet 49 $ pro Monat.', [{ ...price, subjectNames: ['Pro'] }])[0]).toMatchObject({ surfaceText: '49 $', inSync: true });
  });

  it('stays quiet when a sentence prices two subjects', () => {
    const business: FactLike = { ...price, id: 'f3', key: 'business.price', value: { amount: 99, currency: 'USD' }, displayValue: '$99', subjectNames: ['Business'] };
    expect(detectSpans('Pro is $45 and Business is $90.', [price, business])).toEqual([]);
  });
});

describe('deterministic fact check', () => {
  const next = { valueType: 'MONEY' as const, value: { amount: 59, currency: 'USD' }, displayValue: '$59/month' };
  it('requires the new value and rejects the old one', () => {
    expect(deterministicCheck('The Pro plan is just $59 per month', '$49/month', next, { amount: 49 })).toEqual({ pass: true, issues: [] });
    expect(deterministicCheck('The Pro plan is cheap', '$49/month', next, { amount: 49 }).issues[0]).toMatch(/new value/);
    expect(deterministicCheck('Now $59, was $49', '$49/month', next, { amount: 49 }).issues[0]).toMatch(/old number/);
  });
});

describe('literal substitution fallback', () => {
  const next = { value: { amount: 59, currency: 'USD', period: 'month' }, displayValue: '$59/month' };
  it('swaps the display string or the old number, else gives up', () => {
    expect(literalSubstitution('just $49/month', '$49/month', { amount: 49 }, next)).toBe('just $59/month');
    expect(literalSubstitution('$49 per month', '$49/month', { amount: 49 }, next)).toBe('$59 per month');
    expect(literalSubstitution('49 $ pro Monat', '$49/month', { amount: 49 }, next)).toBe('59 $ pro Monat');
    expect(literalSubstitution('under fifty dollars', '$49/month', { amount: 49 }, next)).toBeNull();
  });
});

describe('literal substitution of a conflicting value', () => {
  it('uses the observed number when the span never stated the previous value', () => {
    expect(literalSubstitution('costs $39 per month', '$49/month', { amount: 49 }, { value: { amount: 59 }, displayValue: '$59/month' }, { amount: 39 })).toBe('costs $59 per month');
  });
});
