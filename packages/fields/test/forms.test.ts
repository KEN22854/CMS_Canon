import { describe, expect, it } from 'vitest';
import { formFieldsSchema, spamSignals, validateSubmission, type FormFieldInput } from '../src/forms';

const fields = formFieldsSchema.parse([
  { name: 'name', type: 'text', label: 'Name', required: true },
  { name: 'email', type: 'email', label: 'Email', required: true },
  { name: 'phone', type: 'phone', label: 'Phone' },
  { name: 'seats', type: 'number', label: 'Seats' },
  { name: 'plan', type: 'select', label: 'Plan', options: ['Pro', 'Business'] },
  { name: 'topics', type: 'multiselect', label: 'Topics', options: ['SSO', 'AI'] },
  { name: 'start', type: 'date', label: 'Start' },
  { name: 'message', type: 'textarea', label: 'Message', maxLength: 20 },
  { name: 'privacy', type: 'consent', label: 'I agree', required: true },
  { name: 'campaign', type: 'hidden', label: 'Campaign', defaultValue: 'spring' },
] satisfies FormFieldInput[]);

describe('form definitions', () => {
  it('rejects duplicates, reserved names, choice fields without options and optional consent', () => {
    expect(
      formFieldsSchema.safeParse([
        { name: 'a', type: 'text', label: 'A' },
        { name: 'a', type: 'text', label: 'B' },
      ]).success,
    ).toBe(false);
    expect(formFieldsSchema.safeParse([{ name: '_hp', type: 'text', label: 'x' }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ name: 'plan', type: 'select', label: 'Plan' }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ name: 'ok', type: 'consent', label: 'OK' }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([]).success).toBe(false);
  });
});

describe('validateSubmission', () => {
  it('cleans valid input, drops unknown keys and fills hidden fields', () => {
    const r = validateSubmission(fields, {
      name: '  Ada ',
      email: 'ADA@Example.com',
      seats: '12,5',
      plan: 'Pro',
      topics: ['SSO', 'AI'],
      start: '2026-12-01',
      message: 'Hi',
      privacy: 'on',
      role: 'admin',
      campaign: 'hacked',
    });
    expect(r).toEqual({
      ok: true,
      data: {
        name: 'Ada',
        email: 'ada@example.com',
        seats: 12.5,
        plan: 'Pro',
        topics: ['SSO', 'AI'],
        start: '2026-12-01',
        message: 'Hi',
        privacy: true,
        campaign: 'spring',
      },
    });
  });

  it('reports every field-level problem', () => {
    const r = validateSubmission(fields, {
      email: 'nope',
      phone: 'call me',
      seats: 'many',
      plan: 'Free',
      topics: 'Billing',
      start: '2026-13-45',
      message: 'x'.repeat(21),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual({
      name: 'Required',
      email: 'Enter a valid email',
      phone: 'Enter a valid phone number',
      seats: 'Enter a number',
      plan: 'Choose from the list',
      topics: 'Choose from the list',
      start: 'Enter a date',
      message: 'At most 20 characters',
      privacy: 'Please give your consent',
    });
  });
});

describe('spamSignals', () => {
  it('scores honeypots, speed, links and spam phrases, and leaves real leads alone', () => {
    expect(
      spamSignals({ message: 'We would like a demo for 40 editors next week.' }, { elapsedMs: 30_000 }),
    ).toEqual({ score: 0, reasons: [] });
    expect(spamSignals({ message: 'hi' }, { honeypot: 'http://x' }).score).toBe(1);
    expect(
      spamSignals(
        { message: 'Cheap backlinks www.a.example https://b.example https://c.example' },
        { elapsedMs: 900 },
      ).reasons,
    ).toEqual(['submitted too fast', 'many links', 'spam phrases']);
    expect(spamSignals({ message: 'see https://x.example' }, {}).reasons).toEqual([
      'short message with a link',
    ]);
  });
});
