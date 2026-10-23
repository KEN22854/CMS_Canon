'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useSites, type Site } from '@/lib/content';
import { useTenantId } from '@/lib/queries';

const TEMPLATES = [
  { id: 'landing', label: 'Landing page' },
  { id: 'blog', label: 'Blog' },
  { id: 'docs', label: 'Documentation' },
  { id: 'blank', label: 'Blank' },
];

export default function SitesPage() {
  const sites = useSites();
  const ability = useAbility();
  const tid = useTenantId();
  const qc = useQueryClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('landing');
  const [locales, setLocales] = useState('en');

  const create = useMutation({
    mutationFn: () => {
      const list = locales.split(',').map((l) => l.trim()).filter(Boolean);
      return api<Site>('/sites', { body: { name, template, defaultLocale: list[0] ?? 'en', locales: list } });
    },
    onSuccess: (site) => {
      void qc.invalidateQueries({ queryKey: ['sites', tid] });
      toast.success(`${site.name} created`);
      router.push(`/sites/${site.id}/pages`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader
        title="Sites"
        description="Each site has its own pages, media, locales, theme and domain."
        actions={
          ability.can('create', 'Site') && !creating ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New site
            </Button>
          ) : null
        }
      />

      {creating && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New site</CardTitle>
            <CardDescription>You get a free address on canon.localhost right away; connect a custom domain later.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="site-name">Name</Label>
                <Input id="site-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Blog" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-template">Template</Label>
                <Select id="site-template" className="w-full" value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="site-locales">Locales</Label>
                <Input id="site-locales" value={locales} onChange={(e) => setLocales(e.target.value)} placeholder="en, de" />
              </div>
              <div className="flex gap-2 md:col-span-4">
                <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2}>
                  Create site
                </Button>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {sites.data?.map((s) => (
          <Card key={s.id} className="transition-shadow hover:shadow-md">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate">
                    <Link href={`/sites/${s.id}/pages`} className="hover:underline">
                      {s.name}
                    </Link>
                  </CardTitle>
                  <CardDescription className="truncate">{s.domain ?? s.internalDomain}</CardDescription>
                </div>
                {s.isPublished ? <Badge className="border-success/40 text-success">live</Badge> : <Badge>draft</Badge>}
              </div>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Globe className="h-4 w-4" aria-hidden /> {s.locales.join(', ')} · {s.pageCount ?? 0} pages
              </span>
              <a href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                Open <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </CardContent>
          </Card>
        ))}
        {sites.data?.length === 0 && !creating && <p className="text-sm text-muted-foreground">No sites yet — create the first one.</p>}
      </div>
    </>
  );
}
