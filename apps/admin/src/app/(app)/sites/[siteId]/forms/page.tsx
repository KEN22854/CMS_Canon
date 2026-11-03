'use client';

import type { FormFieldInput } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useForms, type SiteForm } from '@/lib/forms';
import { useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { relativeTime } from '@/lib/utils';

/** Starting points; every field stays editable. */
const TEMPLATES: Record<string, { label: MessageKey; fields: FormFieldInput[]; successMessage: string }> = {
  contact: {
    label: 'forms.tpl.contact',
    successMessage: 'Thanks — we will get back to you shortly.',
    fields: [
      { name: 'name', type: 'text', label: 'Name', required: true, width: 'half' },
      { name: 'email', type: 'email', label: 'Email', required: true, width: 'half' },
      { name: 'message', type: 'textarea', label: 'Message', required: true },
      {
        name: 'privacy',
        type: 'consent',
        label: 'I agree to the processing of my data as described in the privacy policy',
        required: true,
      },
    ],
  },
  demo: {
    label: 'forms.tpl.demo',
    successMessage: 'Thanks — we will contact you within one business day to schedule the demo.',
    fields: [
      { name: 'name', type: 'text', label: 'Full name', required: true, width: 'half' },
      { name: 'email', type: 'email', label: 'Work email', required: true, width: 'half' },
      { name: 'company', type: 'text', label: 'Company', required: true, width: 'half' },
      {
        name: 'teamSize',
        type: 'select',
        label: 'Team size',
        options: ['1–10', '11–50', '51–200', '200+'],
        width: 'half',
      },
      { name: 'phone', type: 'phone', label: 'Phone' },
      { name: 'privacy', type: 'consent', label: 'I agree to be contacted about Canon', required: true },
    ],
  },
  newsletter: {
    label: 'forms.tpl.newsletter',
    successMessage: 'Almost done — check your inbox to confirm.',
    fields: [
      { name: 'email', type: 'email', label: 'Email', required: true },
      {
        name: 'consent',
        type: 'consent',
        label: 'Send me product news (unsubscribe any time)',
        required: true,
      },
    ],
  },
};

export default function FormsPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const forms = useForms(siteId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('contact');
  const t = useT();
  const create = useMutation({
    mutationFn: () =>
      api<SiteForm>(`/sites/${siteId}/forms`, {
        body: {
          name,
          fields: TEMPLATES[template]!.fields,
          successMessage: TEMPLATES[template]!.successMessage,
        },
      }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['forms', tid, siteId] });
      router.push(`/sites/${siteId}/forms/${f.id}?tab=fields`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('forms.intro')}</p>
        {ability.can('create', 'Form') && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t('forms.new')}
          </Button>
        )}
      </div>
      {creating && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-[16rem] flex-1 space-y-1">
              <Label htmlFor="form-name">{t('forms.name')}</Label>
              <Input
                id="form-name"
                value={name}
                placeholder="Contact sales"
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="form-template">{t('forms.startFrom')}</Label>
              <Select id="form-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
                {Object.entries(TEMPLATES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v.label)}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={name.trim().length < 2}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('forms.create')}
            </Button>
          </CardContent>
        </Card>
      )}
      {forms.isError && <Alert tone="error">{errorMessage(forms.error)}</Alert>}
      <div className="grid gap-3">
        {forms.data?.map((f) => (
          <Link key={f.id} href={`/sites/${siteId}/forms/${f.id}`}>
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="flex flex-wrap items-center gap-4 p-4">
                <Inbox className="h-5 w-5 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{f.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('forms.fieldsCount', { count: f.fields.length })} ·{' '}
                    {t('forms.updated', { when: relativeTime(f.updatedAt) })}
                  </p>
                </div>
                {!f.isActive && <Badge>{t('forms.inactive')}</Badge>}
                {(f.newSubmissions ?? 0) > 0 && (
                  <Badge className="border-primary/40 text-primary">
                    {t('forms.newCount', { count: f.newSubmissions ?? 0 })}
                  </Badge>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
        {forms.data?.length === 0 && !creating && (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('forms.empty')}</p>
        )}
      </div>
    </div>
  );
}
