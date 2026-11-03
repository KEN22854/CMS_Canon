'use client';

import { getBlock, type StyleBreakpoint } from '@canon/blocks';
import { useCallback, useMemo } from 'react';
import { useLocale, useT, translate, type MessageKey } from '@/lib/i18n';

/**
 * Localised names for things defined in @canon/blocks (block types, their fields, breakpoints).
 * The registry stays English — it is also the AI catalog and the API's vocabulary — and the admin
 * translates on display, falling back to the registry text for plugin blocks.
 */
export function useBlockLabels() {
  const locale = useLocale();
  const t = useT();
  const tr = useCallback((key: string, fallback: string) => translate(locale, key as MessageKey) || fallback, [locale]);
  return useMemo(
    () => ({
      t,
      name: (type: string) => tr(`block.${type}.name`, getBlock(type)?.name ?? type),
      description: (type: string) => tr(`block.${type}.desc`, getBlock(type)?.description ?? ''),
      field: (type: string, prop: string) => tr(`block.${type}.f.${prop}`, getBlock(type)?.fields[prop]?.label ?? prop),
      item: (type: string, list: string, prop: string) => tr(`block.${type}.i.${prop}`, getBlock(type)?.fields[list]?.itemFields?.[prop]?.label ?? prop),
      bp: (id: StyleBreakpoint) => t(`bp.${id}` as MessageKey),
    }),
    [t, tr],
  );
}
