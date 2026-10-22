'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { Field } from '@/components/auth-form';
import { Alert, Button, Card, CardContent, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';

const TEMPLATES = ['blank', 'blog', 'landing', 'docs', 'ecommerce'] as const;
const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(80),
  template: z.enum(TEMPLATES),
  brandVoice: z.string().max(2000).optional(),
});

export default function NewWorkspacePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const setSession = useAuth((s) => s.setSession);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { template: 'blank' } });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const tenant = await api<{ id: string }>('/tenants', { body: { name: v.name, template: v.template, ai: v.brandVoice ? { brandVoice: v.brandVoice } : undefined } });
      setSession(await api<AuthPayload>('/auth/switch-tenant', { body: { tenantId: tenant.id } }));
      qc.clear();
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <>
      <PageHeader title="New workspace" description="A workspace is a tenant: its own members, sites, content, AI budget and billing." />
      <Card className="max-w-xl">
        <CardContent className="pt-5">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field id="name" label="Name" autoFocus registration={form.register('name')} error={form.formState.errors.name} />
            <div className="space-y-1.5">
              <Label htmlFor="template">Starting template</Label>
              <Select id="template" className="w-full" {...form.register('template')}>
                {TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="brandVoice">Brand voice for AI (optional)</Label>
              <textarea
                id="brandVoice"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                placeholder="Friendly, concise, no jargon."
                {...form.register('brandVoice')}
              />
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create workspace
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
