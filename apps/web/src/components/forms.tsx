'use client';

import { useEffect } from 'react';

type Value = string | boolean | string[];

function show(el: HTMLElement | null, text: string) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}

/**
 * Progressive enhancement for every Canon form on the page: posts JSON, shows field errors next to
 * the inputs and the success message in place, and counts a `form_submit` conversion. Without
 * JavaScript the same forms still work as classic posts.
 */
export function FormEnhancer() {
  useEffect(() => {
    const started = performance.now();
    const forms = [...document.querySelectorAll<HTMLFormElement>('form[data-canon-form]')];
    const offs = forms.map((form) => {
      const onSubmit = async (e: SubmitEvent) => {
        e.preventDefault();
        const formId = form.dataset.canonForm!;
        const fd = new FormData(form);
        const data: Record<string, Value> = {};
        for (const el of [...form.elements] as HTMLInputElement[]) {
          if (!el.name || el.name === '_hp' || el.disabled) continue;
          if (el.type === 'checkbox') {
            const group = form.querySelectorAll(`input[type=checkbox][name="${CSS.escape(el.name)}"]`);
            data[el.name] = group.length > 1 ? fd.getAll(el.name).map(String) : el.checked;
          } else if (!(el.name in data)) data[el.name] = String(fd.get(el.name) ?? '');
        }
        const status = form.querySelector<HTMLElement>('[data-form-status]');
        form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((n) => {
          n.textContent = '';
          n.classList.add('hidden');
        });
        const button = form.querySelector<HTMLButtonElement>('button[type=submit]');
        if (button) button.disabled = true;
        try {
          const res = await fetch(`/api/forms/${formId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              data,
              honeypot: String(fd.get('_hp') ?? '') || undefined,
              elapsedMs: Math.round(performance.now() - started),
              path: location.pathname,
              referrer: document.referrer || undefined,
              locale: document.documentElement.lang || undefined,
            }),
          });
          const out = (await res.json()) as {
            ok: boolean;
            successMessage?: string | null;
            redirectUrl?: string | null;
            code?: string;
            fields?: Record<string, string>;
          };
          if (out.ok) {
            window.canon?.track('form_submit', { form: formId });
            if (out.redirectUrl) return location.assign(out.redirectUrl);
            const done = document.createElement('p');
            done.className = 'text-lg font-medium';
            done.setAttribute('role', 'status');
            done.textContent =
              out.successMessage || form.dataset.success || 'Thank you — we received your message.';
            form.replaceChildren(done);
            return;
          }
          for (const [name, message] of Object.entries(out.fields ?? {}))
            show(form.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(name)}"]`), message);
          show(
            status,
            out.code === 'RATE_LIMITED'
              ? 'Too many attempts — please try again later.'
              : Object.keys(out.fields ?? {}).length
                ? 'Please check the highlighted fields.'
                : 'Something went wrong — please try again.',
          );
        } catch {
          show(status, 'Network error — please try again.');
        } finally {
          if (button) button.disabled = false;
        }
      };
      form.addEventListener('submit', onSubmit);
      return () => form.removeEventListener('submit', onSubmit);
    });
    return () => offs.forEach((off) => off());
  }, []);
  return null;
}
