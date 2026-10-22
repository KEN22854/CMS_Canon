'use client';

import type { ReactNode } from 'react';
import type { FieldError as RhfFieldError, UseFormRegisterReturn } from 'react-hook-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, FieldError, Input, Label } from './ui';

export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
      {footer && <div className="border-t px-5 py-3 text-center text-sm text-muted-foreground">{footer}</div>}
    </Card>
  );
}

export function Field({
  id,
  label,
  error,
  registration,
  hint,
  ...input
}: {
  id: string;
  label: string;
  error?: RhfFieldError;
  registration: UseFormRegisterReturn;
  hint?: ReactNode;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        {hint}
      </div>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} {...registration} {...input} />
      <span id={`${id}-error`}>
        <FieldError message={error?.message} />
      </span>
    </div>
  );
}
