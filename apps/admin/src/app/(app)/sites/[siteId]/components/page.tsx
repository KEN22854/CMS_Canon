'use client';

import { getBlock } from '@canon/blocks';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Badge, Card, EmptyState, Skeleton } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { componentsKey, useComponents, type SiteComponent } from '@/lib/components';
import { useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

/** The site's global components; each opens in the component builder. */
export default function ComponentsPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const t = useT();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const list = useComponents(siteId);
  const remove = useMutation({
    mutationFn: (c: SiteComponent) => api(`/components/${c.id}`, { method: 'DELETE' }),
    onSuccess: () => (toast.success(t('component.deleted')), void qc.invalidateQueries({ queryKey: componentsKey(tid, siteId) })),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('component.listHint')}</p>
      {list.isPending && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      )}
      {list.data?.length === 0 && <EmptyState icon={<Boxes />} title={t('component.listTitle')} description={t('component.empty')} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.map((c) => (
          <Card key={c.id} className="group relative p-4 transition-colors hover:border-primary/50">
            <Link href={`/sites/${siteId}/components/${c.id}`} className="block space-y-1.5">
              <p className="flex items-center gap-2 font-medium">
                <Boxes className="h-4 w-4 text-accent" aria-hidden /> {c.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {getBlock(c.tree.type)?.name ?? c.tree.type} · {relativeTime(c.updatedAt)}
              </p>
              <div className="flex flex-wrap gap-1">
                {c.publishedVersion ? <Badge className="border-success/40 text-success">{t('component.live', { version: c.publishedVersion })}</Badge> : <Badge className="border-warning/40 text-warning">{t('component.notPublished')}</Badge>}
                {c.publishedVersion !== null && c.hasUnpublishedChanges && <Badge className="border-warning/40 text-warning">{t('component.unpublished')}</Badge>}
              </div>
            </Link>
            {ability.can('delete', 'Page') && (
              <button type="button" aria-label={t('component.delete')} title={t('component.delete')} onClick={() => window.confirm(t('component.deleteConfirm', { name: c.name })) && remove.mutate(c)} className="absolute right-3 top-3 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive group-hover:opacity-100 focus:opacity-100">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
