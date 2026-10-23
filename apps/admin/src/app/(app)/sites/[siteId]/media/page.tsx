'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Film, Sparkles, Trash2, Upload } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { ApiError, api, errorMessage } from '@/lib/api';
import { uploadMedia, useMedia, type MediaItem } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd } from '@/lib/utils';

export default function MediaLibrary() {
  const { siteId } = useParams<{ siteId: string }>();
  const [q, setQ] = useState('');
  const media = useMedia(siteId, q);
  const ability = useAbility();
  const tid = useTenantId();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = media.data?.find((m) => m.id === selectedId) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['media', tid, siteId] });

  const uploadAll = async (files: FileList | File[]) => {
    const list = [...files];
    setUploading((n) => n + list.length);
    // Sequential: keeps memory flat and makes per-file errors readable.
    for (const f of list) {
      try {
        const m = await uploadMedia(siteId, f);
        toast.success(m.duplicate ? `${f.name} already exists — reused` : `${f.name} uploaded`);
        setSelectedId(m.id);
      } catch (err) {
        toast.error(`${f.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    void refresh();
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (ability.can('create', 'Media') && e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
      }}
      className={cn('rounded-lg', dragOver && 'outline-dashed outline-2 outline-primary')}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search by name or alt text" value={q} onChange={(e) => setQ(e.target.value)} />
        {ability.can('create', 'Media') && (
          <>
            <input ref={fileRef} type="file" multiple hidden accept="image/*,video/mp4,video/webm,application/pdf" onChange={(e) => e.target.files && void uploadAll(e.target.files)} />
            <Button onClick={() => fileRef.current?.click()} loading={uploading > 0}>
              <Upload className="h-4 w-4" /> {uploading > 0 ? `Uploading ${uploading}…` : 'Upload'}
            </Button>
            <span className="text-xs text-muted-foreground">or drop files here · JPEG, PNG, GIF, WebP, AVIF, MP4, WebM, PDF</span>
          </>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {media.data?.map((m) => (
            <button key={m.id} type="button" onClick={() => setSelectedId(m.id)} className={cn('overflow-hidden rounded-md border bg-card text-left', selectedId === m.id && 'ring-2 ring-primary')}>
              <Thumb m={m} />
              <div className="flex items-center gap-1 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs">{m.originalName}</span>
                {!m.alt && m.mimeType.startsWith('image/') && <Badge className="border-warning/40 text-[10px] text-warning">no alt</Badge>}
              </div>
            </button>
          ))}
          {media.data?.length === 0 && <p className="col-span-full rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">No media yet.</p>}
        </div>
        {selected && <Details key={selected.id} m={selected} onChanged={refresh} onDeleted={() => (setSelectedId(null), void refresh())} />}
      </div>
    </div>
  );
}

function Thumb({ m }: { m: MediaItem }) {
  if (m.mimeType.startsWith('image/') && (m.thumbnailUrl || m.url)) {
    // eslint-disable-next-line @next/next/no-img-element -- media CDN thumbnail
    return <img src={m.thumbnailUrl ?? m.url} alt={m.alt ?? ''} loading="lazy" className="aspect-square w-full object-cover" style={{ backgroundColor: m.dominantColor ?? undefined }} />;
  }
  const Icon = m.mimeType.startsWith('video/') ? Film : FileText;
  return (
    <div className="grid aspect-square place-items-center bg-muted text-muted-foreground">
      <Icon className="h-8 w-8" aria-hidden />
    </div>
  );
}

function Details({ m, onChanged, onDeleted }: { m: MediaItem; onChanged: () => void; onDeleted: () => void }) {
  const ability = useAbility();
  const canEdit = ability.can('update', 'Media');
  const [alt, setAlt] = useState(m.alt ?? '');
  const [caption, setCaption] = useState(m.caption ?? '');
  const [tags, setTags] = useState(m.tags.join(', '));
  const usage = useQuery({ queryKey: ['media-usage', m.id], queryFn: () => api<{ id: string; title: string; fullPath: string; locale: string }[]>(`/media/${m.id}/usage`) });

  const save = useMutation({
    mutationFn: () => api(`/media/${m.id}`, { method: 'PATCH', body: { alt: alt || null, caption: caption || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } }),
    onSuccess: () => (toast.success('Saved'), onChanged()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const aiAlt = useMutation({
    mutationFn: () => api<{ alt: string; costUsd: number; model: string }>(`/media/${m.id}/ai-alt`, { body: { apply: false } }),
    onSuccess: (r) => (setAlt(r.alt), toast.success(`Suggested by ${r.model} · ${formatUsd(r.costUsd)} — review and save`)),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (force: boolean) => api(`/media/${m.id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    onSuccess: onDeleted,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'MEDIA_IN_USE' && window.confirm(`${err.message}. Delete anyway? Those pages will lose the image.`)) remove.mutate(true);
      else if (!(err instanceof ApiError && err.code === 'MEDIA_IN_USE')) toast.error(errorMessage(err));
    },
  });

  return (
    <Card className="w-full shrink-0 space-y-4 p-4 lg:w-80">
      <Thumb m={m} />
      <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
        <dt>Type</dt>
        <dd>{m.mimeType}</dd>
        <dt>Size</dt>
        <dd>{(m.size / 1024).toFixed(0)} KB</dd>
        {m.width && (
          <>
            <dt>Dimensions</dt>
            <dd>
              {m.width}×{m.height}
            </dd>
          </>
        )}
      </dl>
      <a href={m.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary hover:underline">
        {m.url}
      </a>
      {m.mimeType.startsWith('image/') && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="m-alt">Alt text</Label>
            {canEdit && ability.can('invoke', 'Ai') && (
              <Button size="sm" variant="ghost" loading={aiAlt.isPending} onClick={() => aiAlt.mutate()}>
                <Sparkles className="h-3.5 w-3.5" /> Generate
              </Button>
            )}
          </div>
          <textarea id="m-alt" rows={2} disabled={!canEdit} value={alt} onChange={(e) => setAlt(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          {m.altGenerated && <p className="text-[11px] text-muted-foreground">Generated by AI</p>}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="m-caption">Caption</Label>
        <Input id="m-caption" disabled={!canEdit} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="m-tags">Tags</Label>
        <Input id="m-tags" disabled={!canEdit} value={tags} placeholder="brand, hero" onChange={(e) => setTags(e.target.value)} />
      </div>
      <div className="text-xs text-muted-foreground">
        Used on: {usage.data?.length ? usage.data.map((u) => `${u.locale}:${u.fullPath}`).join(', ') : 'no pages'}
      </div>
      <div className="flex justify-between">
        {canEdit && (
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        )}
        {ability.can('delete', 'Media') && (
          <Button size="sm" variant="ghost" aria-label="Delete media" onClick={() => remove.mutate(false)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </Card>
  );
}
