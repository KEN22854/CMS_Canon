import type { ReactNode } from 'react';

/** The public view of a form (what the delivery API ships with the page). */
export interface RenderFormField {
  name: string;
  type:
    | 'text'
    | 'textarea'
    | 'email'
    | 'phone'
    | 'number'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'consent'
    | 'date'
    | 'hidden';
  label: string;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  maxLength?: number;
  width?: 'full' | 'half';
}

export interface RenderForm {
  id: string;
  name: string;
  fields: RenderFormField[];
  successMessage: string | null;
  redirectUrl: string | null;
  privacyNote: string | null;
  isActive: boolean;
}

const INPUT =
  'w-full rounded-site border border-site-fg/20 bg-site-bg px-3 py-2 text-site-fg outline-none focus:border-site-primary focus:ring-2 focus:ring-site-primary/30';
const TYPE: Partial<Record<RenderFormField['type'], string>> = {
  email: 'email',
  phone: 'tel',
  number: 'number',
  date: 'date',
  text: 'text',
};

function Field({ f, formId, inert }: { f: RenderFormField; formId: string; inert: boolean }): ReactNode {
  const id = `${formId}-${f.name}`;
  const common = {
    id,
    name: f.name,
    required: f.required,
    disabled: inert,
    'aria-describedby': `${id}-error${f.help ? ` ${id}-help` : ''}`,
  };
  const help = f.help ? (
    <p id={`${id}-help`} className="mt-1 text-xs opacity-70">
      {f.help}
    </p>
  ) : null;
  const error = (
    <p id={`${id}-error`} data-error-for={f.name} role="alert" className="mt-1 hidden text-xs text-red-600" />
  );
  const label = (
    <label htmlFor={id} className="mb-1 block text-sm font-medium">
      {f.label}
      {f.required && <span aria-hidden> *</span>}
    </label>
  );
  const span = f.width === 'half' ? '@xl:col-span-1' : '@xl:col-span-2';

  if (f.type === 'checkbox' || f.type === 'consent') {
    return (
      <div className={span}>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" {...common} className="mt-1" />
          <span>
            {f.label}
            {f.required && <span aria-hidden> *</span>}
          </span>
        </label>
        {help}
        {error}
      </div>
    );
  }
  if (f.type === 'multiselect') {
    return (
      <fieldset className={span} disabled={inert}>
        <legend className="mb-1 text-sm font-medium">
          {f.label}
          {f.required && <span aria-hidden> *</span>}
        </legend>
        <div className="flex flex-wrap gap-3">
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name={f.name} value={o} /> {o}
            </label>
          ))}
        </div>
        {help}
        {error}
      </fieldset>
    );
  }
  return (
    <div className={span}>
      {label}
      {f.type === 'textarea' ? (
        <textarea
          {...common}
          rows={4}
          maxLength={f.maxLength}
          placeholder={f.placeholder}
          className={INPUT}
        />
      ) : f.type === 'select' ? (
        <select {...common} defaultValue="" className={INPUT}>
          <option value="" disabled>
            {f.placeholder ?? 'Choose…'}
          </option>
          {(f.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input
          type={TYPE[f.type] ?? 'text'}
          {...common}
          maxLength={f.maxLength}
          placeholder={f.placeholder}
          autoComplete={
            f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.name === 'name' ? 'name' : undefined
          }
          className={INPUT}
        />
      )}
      {help}
      {error}
    </div>
  );
}

/**
 * A real HTML form: it posts to the renderer (/api/forms/<id>) and works without JavaScript; the
 * site script progressively enhances it (inline errors, success message without a reload). The
 * hidden `_hp` input is a honeypot — people never see or fill it.
 */
export function FormView({
  form,
  title,
  intro,
  submitLabel,
  layout,
  inert,
  attrs,
}: {
  form: RenderForm;
  title: string;
  intro: string;
  submitLabel: string;
  layout: string;
  inert: boolean;
  attrs: Record<string, string>;
}): ReactNode {
  return (
    <section {...attrs} className="mx-auto max-w-2xl px-6 py-12">
      <div
        className={
          layout === 'card' ? 'rounded-site border border-site-fg/10 bg-site-bg p-6 shadow-sm @xl:p-8' : ''
        }
      >
        {title && <h2 className="text-2xl font-bold">{title}</h2>}
        {intro && <p className="mt-2 opacity-80">{intro}</p>}
        <form
          action={`/api/forms/${form.id}`}
          method="post"
          data-canon-form={form.id}
          data-success={form.successMessage ?? ''}
          data-redirect={form.redirectUrl ?? ''}
          noValidate={false}
          className="mt-6 grid grid-cols-1 gap-4 @xl:grid-cols-2"
        >
          <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label>
              Leave this empty
              <input type="text" name="_hp" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          {form.fields.map((f) => (
            <Field key={f.name} f={f} formId={form.id} inert={inert} />
          ))}
          <div className="@xl:col-span-2">
            <button
              type="submit"
              disabled={inert}
              className="rounded-site bg-site-primary px-6 py-3 font-semibold text-site-on-primary shadow hover:opacity-90 disabled:opacity-60"
            >
              {submitLabel || 'Send'}
            </button>
            {form.privacyNote && <p className="mt-3 text-xs opacity-70">{form.privacyNote}</p>}
            <p data-form-status role="status" className="mt-3 hidden text-sm" />
          </div>
        </form>
      </div>
    </section>
  );
}
