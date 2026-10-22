/**
 * Minimal mustache-style renderer for versioned prompts ({{name}} only, no logic).
 * Unknown placeholders are left verbatim on purpose: prompts legitimately contain literal
 * tokens such as {{fact:pro_plan.price}} that must reach the model untouched.
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
