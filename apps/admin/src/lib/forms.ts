import type { FormField } from '@canon/fields';
import type { RenderForm } from '@canon/ui-blocks';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTenantId } from './queries';

export interface SiteForm {
  id: string;
  siteId: string;
  name: string;
  slug: string;
  fields: FormField[];
  successMessage: string | null;
  redirectUrl: string | null;
  notificationEmails: string[];
  settings: { notifyMembers?: boolean; privacyNote?: string };
  aiSettings: { spamDetection?: boolean };
  isActive: boolean;
  newSubmissions?: number;
  createdAt: string;
  updatedAt: string;
}

export type SubmissionStatus = 'NEW' | 'READ' | 'ARCHIVED' | 'SPAM';

export interface Submission {
  id: string;
  formId: string;
  data: Record<string, string | number | boolean | string[]>;
  status: SubmissionStatus;
  spamScore: number | null;
  aiClassification: {
    spam: boolean;
    confidence: number;
    category: string | null;
    summary: string | null;
  } | null;
  meta: {
    path?: string | null;
    referrer?: string | null;
    utm?: { source?: string } | null;
    country?: string | null;
    consent?: { name: string; label: string; given: boolean }[];
    spamReasons?: string[];
  };
  ipAddress: string | null;
  createdAt: string;
}

export function useForms(siteId: string) {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['forms', tid, siteId],
    queryFn: () => api<SiteForm[]>(`/sites/${siteId}/forms`),
    enabled: Boolean(tid && siteId),
  });
}

export function useForm(formId: string) {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['form', tid, formId],
    queryFn: () => api<SiteForm>(`/forms/${formId}`),
    enabled: Boolean(tid && formId),
  });
}

/** The same public view the renderer gets, for the builder canvas preview. */
export function toRenderForms(forms: SiteForm[] | undefined): Record<string, RenderForm> {
  return Object.fromEntries(
    (forms ?? []).map((f) => [
      f.id,
      {
        id: f.id,
        name: f.name,
        fields: f.fields.filter((x) => x.type !== 'hidden'),
        successMessage: f.successMessage,
        redirectUrl: f.redirectUrl,
        privacyNote: f.settings.privacyNote ?? null,
        isActive: f.isActive,
      },
    ]),
  );
}

export const FIELD_TYPE_LABEL: Record<FormField['type'], string> = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  select: 'Dropdown',
  multiselect: 'Multiple choice',
  checkbox: 'Checkbox',
  consent: 'Consent (required)',
  date: 'Date',
  hidden: 'Hidden value',
};
