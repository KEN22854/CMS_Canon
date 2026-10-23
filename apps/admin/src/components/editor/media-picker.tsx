'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { uploadMedia, useMedia } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { Button, Input } from '../ui';

export function MediaPicker({ siteId, value, onChange }: { siteId: string; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const media = useMedia(siteId);
  const selected = media.data?.find((m) => m.id === value);
  return (
    <div className="space-y-2">
      {selected?.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from the media CDN
        <img src={selected.thumbnailUrl} alt={selected.alt ?? ''} className="h-28 w-full rounded-md border object-cover" style={{ backgroundColor: selected.dominantColor ?? undefined }} />
      ) : (
        <div className="grid h-28 place-items-center rounded-md border border-dashed text-xs text-muted-foreground">{value ? 'Media not found' : 'No image'}</div>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          <ImagePlus className="h-4 w-4" /> {value ? 'Change' : 'Choose'}
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
            Remove
          </Button>
        )}
      </div>
      {open && <PickerDialog siteId={siteId} onClose={() => setOpen(false)} onPick={(id) => (onChange(id), setOpen(false))} />}
    </div>
  );
}

function PickerDialog({ siteId, onClose, onPick }: { siteId: string; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const media = useMedia(siteId, q);
  const qc = useQueryClient();
  const tid = useTenantId();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const m = await uploadMedia(siteId, file);
      void qc.invalidateQueries({ queryKey: ['media', tid, siteId] });
      onPick(m.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Choose media">
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b p-3">
          <Input placeholder="Search media" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
          <Button type="button" variant="outline" loading={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Upload
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-3 overflow-y-auto p-3 sm:grid-cols-4">
          {media.data
            ?.filter((m) => m.mimeType.startsWith('image/'))
            .map((m) => (
              <button key={m.id} type="button" onClick={() => onPick(m.id)} className="group overflow-hidden rounded-md border text-left hover:ring-2 hover:ring-primary">
                {/* eslint-disable-next-line @next/next/no-img-element -- media CDN thumbnail */}
                <img src={m.thumbnailUrl ?? m.url} alt={m.alt ?? ''} className="aspect-square w-full object-cover" style={{ backgroundColor: m.dominantColor ?? undefined }} loading="lazy" />
                <span className="block truncate px-2 py-1 text-xs">{m.originalName}</span>
              </button>
            ))}
          {media.data?.length === 0 && <p className="col-span-full p-6 text-center text-sm text-muted-foreground">No images yet — upload one.</p>}
        </div>
      </div>
    </div>
  );
}
