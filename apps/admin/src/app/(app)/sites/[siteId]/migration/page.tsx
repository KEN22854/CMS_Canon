'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, Upload } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Report {
  dryRun: boolean;
  source: { title: string; link: string };
  posts: { total: number; published: number; drafts: number };
  pages: { total: number; published: number; drafts: number };
  categories: string[];
  authors: string[];
  images: number;
  skipped: Record<string, number>;
  redirects: { from: string; to: string }[];
  created?: { entries: number; pages: number; redirects: number; collection: string };
  warnings: string[];
  errors: { item: string; message: string }[];
}

export default function MigrationPage() {
  const t = useT();
  const { siteId } = useParams<{ siteId: string }>();
  const qc = useQueryClient();
  const ability = useAbility();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const send = (f: File, dryRun: boolean) => {
    const form = new FormData();
    form.set('file', f);
    return api<Report>(`/sites/${siteId}/migrations/wordpress${dryRun ? '?dryRun=true' : ''}`, { form });
  };
  const check = useMutation({ mutationFn: (f: File) => send(f, true), onError: (e) => toast.error(errorMessage(e)) });
  const run = useMutation({
    mutationFn: () => send(file!, false),
    onSuccess: (r) => {
      toast.success(t('mig.done', { entries: r.created?.entries ?? 0, pages: r.created?.pages ?? 0, redirects: r.created?.redirects ?? 0 }));
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const r = run.data ?? check.data;
  const reset = () => (setFile(null), check.reset(), run.reset());

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('mig.title')}</CardTitle>
          <CardDescription>{t('mig.intro')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border p-4">
            <p className="font-medium">{t('mig.wordpress')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('mig.wpHow')}</p>
            <input
              ref={input}
              type="file"
              accept=".xml,application/xml,text/xml"
              hidden
              aria-label={t('mig.choose')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                run.reset();
                setFile(f);
                check.mutate(f);
              }}
            />
            {!r && (
              <Button className="mt-3" variant="outline" loading={check.isPending} disabled={!ability.can('create', 'Page')} onClick={() => input.current?.click()}>
                <FileUp className="h-4 w-4" /> {check.isPending ? t('mig.checking') : t('mig.choose')}
              </Button>
            )}
          </div>

          {r && (
            <section aria-label={t('mig.report', { title: r.source.title || file?.name || '' })} className="space-y-2 rounded-md border bg-muted/30 p-4 text-sm">
              <h3 className="font-semibold">{t('mig.report', { title: r.source.title || file?.name || '' })}</h3>
              <p>{t('mig.posts', r.posts)}</p>
              <p>{t('mig.pages', r.pages)}</p>
              {r.categories.length > 0 && <p>{t('mig.categories', { list: r.categories.join(', ') })}</p>}
              {r.authors.length > 0 && <p>{t('mig.authors', { list: r.authors.join(', ') })}</p>}
              <p>{t('mig.redirects', { count: r.redirects.length })}</p>
              {r.redirects.length > 0 && (
                <ul className="max-h-32 overflow-y-auto rounded border bg-background p-2 font-mono text-[11px]">
                  {r.redirects.slice(0, 50).map((x) => (
                    <li key={x.from}>
                      {x.from} → {x.to}
                    </li>
                  ))}
                </ul>
              )}
              {Object.keys(r.skipped).length > 0 && <p className="text-muted-foreground">{t('mig.skipped', { list: Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(', ') })}</p>}
              {r.warnings.map((w) => (
                <Alert key={w}>{w}</Alert>
              ))}
              {r.errors.length > 0 && (
                <Alert tone="error">
                  {t('mig.errors')}: {r.errors.map((e) => `${e.item} — ${e.message}`).join('; ')}
                </Alert>
              )}
              <div className="flex flex-wrap gap-2 pt-2">
                {r.dryRun && !run.data && (
                  <Button loading={run.isPending} onClick={() => run.mutate()}>
                    <Upload className="h-4 w-4" /> {run.isPending ? t('mig.importing') : t('mig.import')}
                  </Button>
                )}
                {run.data?.created && (
                  <>
                    <Link href={`/sites/${siteId}/collections`}>
                      <Button variant="outline">{t('mig.openBlog')}</Button>
                    </Link>
                    <Link href={`/sites/${siteId}/pages`}>
                      <Button variant="outline">{t('mig.openPages')}</Button>
                    </Link>
                  </>
                )}
                <Button variant="ghost" onClick={reset}>
                  {t('mig.again')}
                </Button>
              </div>
            </section>
          )}

          <div className="rounded-md border border-dashed p-4">
            <p className="font-medium">{t('mig.other')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('mig.otherHint')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
