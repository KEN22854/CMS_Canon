'use client';

import type { BlockPatch } from '@canon/edge';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PatchEditor, SuggestButton, editableBlocks } from '@/components/experiences/patch-editor';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { usePage, usePages } from '@/lib/content';
import { SEGMENT_ATTRIBUTES, SEGMENT_OPERATORS, useSegments, type PagePersonalization, type Segment, type SegmentCondition, type SegmentRules } from '@/lib/experiences';
import { useTenantId } from '@/lib/queries';

const ATTR_LABEL: Record<SegmentCondition['attr'], string> = {
  country: 'Country (ISO code)',
  device: 'Device',
  language: 'Browser language',
  referrerDomain: 'Came from (domain)',
  utmSource: 'UTM source',
  utmMedium: 'UTM medium',
  utmCampaign: 'UTM campaign',
  visitCount: 'Visit number',
  returning: 'Returning visitor',
  path: 'Page path',
};
const OP_LABEL: Record<SegmentCondition['op'], string> = { eq: 'is', neq: 'is not', in: 'is one of', notIn: 'is none of', contains: 'contains', startsWith: 'starts with', gte: '≥', lte: '≤', exists: 'is known' };

/** Ops that make sense per attribute (the API enforces the same). */
function opsFor(attr: SegmentCondition['attr']): SegmentCondition['op'][] {
  if (attr === 'visitCount') return ['eq', 'gte', 'lte'];
  if (attr === 'returning') return ['eq'];
  if (attr === 'device') return ['eq', 'neq', 'in'];
  return SEGMENT_OPERATORS.filter((o) => o !== 'gte' && o !== 'lte');
}

function coerce(c: SegmentCondition, raw: string): SegmentCondition {
  if (c.op === 'exists') return { attr: c.attr, op: c.op };
  if (c.attr === 'visitCount') return { ...c, value: Number(raw) || 1 };
  if (c.attr === 'returning') return { ...c, value: raw === 'true' };
  if (c.op === 'in' || c.op === 'notIn') return { ...c, value: raw.split(',').map((s) => s.trim()).filter(Boolean) };
  return { ...c, value: raw };
}
const shown = (v: SegmentCondition['value']) => (Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v));

function describe(rules: SegmentRules) {
  return rules.conditions.map((c) => `${ATTR_LABEL[c.attr]} ${OP_LABEL[c.op]}${c.op === 'exists' ? '' : ` ${shown(c.value)}`}`).join(rules.match === 'all' ? ' and ' : ' or ');
}

export default function Audiences() {
  const { siteId } = useParams<{ siteId: string }>();
  const ability = useAbility();
  const segments = useSegments(siteId);
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);
  const canEdit = ability.can('update', 'Page');

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Audience segments</h2>
            <p className="text-sm text-muted-foreground">Evaluated at the edge on every request from country, device, language, referrer, campaign and visit history — no personal data, no cookies beyond a random visitor id.</p>
          </div>
          {canEdit && editing === null && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" /> New segment
            </Button>
          )}
        </div>
        {editing && <SegmentForm siteId={siteId} segment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
        {segments.isError && <Alert tone="error">{errorMessage(segments.error)}</Alert>}
        <div className="grid gap-3 md:grid-cols-2">
          {segments.data?.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex items-start gap-3 p-4">
                <Users className="mt-0.5 h-4 w-4 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{describe(s.rules)}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {s.personalizations} personalized page{s.personalizations === 1 ? '' : 's'}
                  </p>
                </div>
                {canEdit && (
                  <button type="button" aria-label={`Edit ${s.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => setEditing(s)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </CardContent>
            </Card>
          ))}
          {segments.data?.length === 0 && !editing && <p className="text-sm text-muted-foreground">No segments yet — for example “Visitors from Germany” or “Came from the spring campaign”.</p>}
        </div>
      </section>

      <PersonalizeSection siteId={siteId} segments={segments.data ?? []} />
    </div>
  );
}

function SegmentForm({ siteId, segment, onClose }: { siteId: string; segment: Segment | null; onClose: () => void }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const [name, setName] = useState(segment?.name ?? '');
  const [rules, setRules] = useState<SegmentRules>(segment?.rules ?? { match: 'all', conditions: [{ attr: 'country', op: 'eq', value: '' }] });
  const [sample, setSample] = useState({ country: 'DE', device: 'mobile' as 'mobile' | 'tablet' | 'desktop', utmSource: '', visitCount: 1 });
  const done = () => (void qc.invalidateQueries({ queryKey: ['segments', tid, siteId] }), onClose());
  const save = useMutation({
    mutationFn: () => (segment ? api(`/sites/${siteId}/segments/${segment.id}`, { method: 'PATCH', body: { name, rules } }) : api(`/sites/${siteId}/segments`, { body: { name, rules } })),
    onSuccess: () => (toast.success('Segment saved'), done()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({ mutationFn: () => api(`/sites/${siteId}/segments/${segment!.id}`, { method: 'DELETE' }), onSuccess: done, onError: (err) => toast.error(errorMessage(err)) });
  const test = useMutation({
    mutationFn: () => api<{ matches: boolean }>(`/sites/${siteId}/segments/test`, { body: { rules, context: { country: sample.country || null, device: sample.device, utmSource: sample.utmSource || null, visitCount: sample.visitCount } } }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const setCond = (i: number, c: SegmentCondition) => (setRules({ ...rules, conditions: rules.conditions.map((x, j) => (j === i ? c : x)) }), test.reset());

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <Label htmlFor="seg-name">Name</Label>
            <Input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Visitors from Germany" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seg-match">Match</Label>
            <Select id="seg-match" value={rules.match} onChange={(e) => setRules({ ...rules, match: e.target.value as 'all' | 'any' })}>
              <option value="all">all conditions</option>
              <option value="any">any condition</option>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          {rules.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label="Attribute" value={c.attr} className="w-52" onChange={(e) => setCond(i, { attr: e.target.value as SegmentCondition['attr'], op: opsFor(e.target.value as SegmentCondition['attr'])[0]!, value: e.target.value === 'returning' ? true : e.target.value === 'visitCount' ? 2 : '' })}>
                {SEGMENT_ATTRIBUTES.map((a) => (
                  <option key={a} value={a}>
                    {ATTR_LABEL[a]}
                  </option>
                ))}
              </Select>
              <Select aria-label="Operator" value={c.op} className="w-36" onChange={(e) => setCond(i, coerce({ ...c, op: e.target.value as SegmentCondition['op'] }, shown(c.value)))}>
                {opsFor(c.attr).map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </Select>
              {c.op !== 'exists' &&
                (c.attr === 'returning' ? (
                  <Select aria-label="Value" value={String(c.value ?? true)} className="w-28" onChange={(e) => setCond(i, coerce(c, e.target.value))}>
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </Select>
                ) : c.attr === 'device' && c.op !== 'in' ? (
                  <Select aria-label="Value" value={shown(c.value) || 'mobile'} className="w-32" onChange={(e) => setCond(i, coerce(c, e.target.value))}>
                    {['mobile', 'tablet', 'desktop'].map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </Select>
                ) : (
                  <Input aria-label="Value" className="w-56" type={c.attr === 'visitCount' ? 'number' : 'text'} value={shown(c.value)} placeholder={c.op === 'in' || c.op === 'notIn' ? 'DE, AT, CH' : ''} onChange={(e) => setCond(i, coerce(c, e.target.value))} />
                ))}
              {rules.conditions.length > 1 && (
                <button type="button" aria-label="Remove condition" className="text-muted-foreground hover:text-destructive" onClick={() => setRules({ ...rules, conditions: rules.conditions.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {rules.conditions.length < 10 && (
            <Button size="sm" variant="ghost" onClick={() => setRules({ ...rules, conditions: [...rules.conditions, { attr: 'device', op: 'eq', value: 'mobile' }] })}>
              <Plus className="h-4 w-4" /> Add condition
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/40 p-3">
          <p className="w-full text-xs font-medium">Try a visitor</p>
          <Input aria-label="Sample country" className="w-20" value={sample.country} onChange={(e) => (setSample({ ...sample, country: e.target.value.toUpperCase().slice(0, 2) }), test.reset())} />
          <Select aria-label="Sample device" className="w-32" value={sample.device} onChange={(e) => (setSample({ ...sample, device: e.target.value as typeof sample.device }), test.reset())}>
            {['mobile', 'tablet', 'desktop'].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </Select>
          <Input aria-label="Sample UTM source" className="w-36" placeholder="utm source" value={sample.utmSource} onChange={(e) => (setSample({ ...sample, utmSource: e.target.value }), test.reset())} />
          <Input aria-label="Sample visit number" className="w-20" type="number" min={1} value={sample.visitCount} onChange={(e) => (setSample({ ...sample, visitCount: Math.max(1, Number(e.target.value) || 1) }), test.reset())} />
          <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
            Test
          </Button>
          {test.data && <Badge className={test.data.matches ? 'border-success/40 text-success' : ''}>{test.data.matches ? 'In segment' : 'Not in segment'}</Badge>}
        </div>
        <div className="flex justify-between gap-2">
          {segment ? (
            <Button variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => window.confirm(`Delete “${segment.name}”? Its personalizations stop immediately.`) && remove.mutate()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Save segment
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PersonalizeSection({ siteId, segments }: { siteId: string; segments: Segment[] }) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const pages = usePages(siteId);
  const published = (pages.data ?? []).filter((p) => p.publishedVersion !== null);
  const [pageId, setPageId] = useState('');
  const page = usePage(siteId, pageId);
  const blocks = useMemo(() => (page.data ? editableBlocks(page.data.content.root) : []), [page.data]);
  const list = useQuery({ queryKey: ['personalizations', tid, pageId], queryFn: () => api<PagePersonalization[]>(`/sites/${siteId}/pages/${pageId}/personalizations`), enabled: Boolean(tid && pageId) });
  const [segmentId, setSegmentId] = useState('');
  const [patch, setPatch] = useState<BlockPatch>({});
  const canPublish = ability.can('publish', 'Page');

  const upsert = useMutation({
    mutationFn: (body: { segmentId: string; patch: BlockPatch; status?: 'ACTIVE' | 'PAUSED'; priority?: number }) => api<PagePersonalization[]>(`/sites/${siteId}/pages/${pageId}/personalizations`, { method: 'PUT', body }),
    onSuccess: (rows) => {
      qc.setQueryData(['personalizations', tid, pageId], rows);
      void qc.invalidateQueries({ queryKey: ['segments', tid, siteId] });
      toast.success('Live — matching visitors see it on their next page load');
      setSegmentId('');
      setPatch({});
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<PagePersonalization[]>(`/sites/${siteId}/pages/${pageId}/personalizations/${id}`, { method: 'DELETE' }),
    onSuccess: (rows) => qc.setQueryData(['personalizations', tid, pageId], rows),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Personalized pages</h2>
        <p className="text-sm text-muted-foreground">Show a segment different copy on a published page. Each segment gets its own cached copy; everyone else sees the page as published. Active A/B tests on the same page apply on top.</p>
      </div>
      <Select aria-label="Page to personalize" className="max-w-md" value={pageId} onChange={(e) => (setPageId(e.target.value), setPatch({}), setSegmentId(''))}>
        <option value="">Choose a published page…</option>
        {published.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title} · {p.locale} · {p.fullPath}
          </option>
        ))}
      </Select>
      {pageId && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">On this page</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {list.data?.map((p) => (
                <div key={p.id} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{p.segment.name}</p>
                    <div className="flex items-center gap-2">
                      <Badge className={p.status === 'ACTIVE' ? 'border-success/40 text-success' : ''}>{p.status.toLowerCase()}</Badge>
                      {canPublish && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => upsert.mutate({ segmentId: p.segment.id, patch: p.patch, priority: p.priority, status: p.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>
                            {p.status === 'ACTIVE' ? 'Pause' : 'Activate'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => (setSegmentId(p.segment.id), setPatch(p.patch))}>
                            Edit
                          </Button>
                          <button type="button" aria-label="Remove personalization" className="text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(p.id)}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <PatchEditor blocks={blocks} patch={p.patch} onChange={() => undefined} disabled />
                </div>
              ))}
              {list.data?.length === 0 && <p className="text-sm text-muted-foreground">Everyone sees the published page.</p>}
            </CardContent>
          </Card>
          {canPublish && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Personalize for a segment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {segments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Create a segment first.</p>
                ) : (
                  <>
                    <Select aria-label="Segment" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                      <option value="">Choose a segment…</option>
                      {segments.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                    {segmentId && (
                      <>
                        {ability.can('invoke', 'Ai') && <SuggestButton siteId={siteId} pageId={pageId} blocks={blocks} segmentId={segmentId} label="Write for this segment" onPick={(s) => s[0] && setPatch({ ...patch, ...s[0].patch })} />}
                        <PatchEditor blocks={blocks} patch={patch} onChange={setPatch} />
                        <div className="flex justify-end">
                          <Button disabled={!Object.keys(patch).length} loading={upsert.isPending} onClick={() => upsert.mutate({ segmentId, patch })}>
                            Save &amp; go live
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}
