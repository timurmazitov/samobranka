'use client';

import { createContext, useContext, useEffect } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

/**
 * The meeting-details view renders exactly one toolbar bar: the
 * «Транскрипт / Конспект» toggles on the left and the ACTIVE mode's buttons
 * flowing right after them. `MeetingDetailsSplitView` owns the bar and
 * publishes its content outlet through this context; the active panel
 * registers its button row via `usePanelToolbar` and the bar renders it next
 * to the toggles. The inactive panel is unmounted, so its registration is
 * withdrawn automatically and the visible button set always matches the
 * mode.
 *
 * Outside a split view (standalone panel use, tests) the context is null:
 * `usePanelToolbar` reports that and the panel falls back to rendering its
 * header in place, as it does today.
 */
export const PanelToolbarOutletContext = createContext<Dispatch<
  SetStateAction<ReactNode>
> | null>(null);

/**
 * Registers `node` as the toolbar bar's content while the calling panel is
 * mounted. Re-registers on every render of the caller (the outlet lives in a
 * different subtree, so this never feeds back into the caller); the unmount
 * cleanup withdraws the content. Returns whether a split view captured the
 * node — false means the panel must render its header locally.
 */
export function usePanelToolbar(node: ReactNode): boolean {
  const setOutlet = useContext(PanelToolbarOutletContext);
  useEffect(() => {
    if (!setOutlet) return;
    setOutlet(node);
    return () => setOutlet(null);
  });
  return setOutlet !== null;
}

/**
 * Shared min-width of the two mode button groups (transcript actions and the
 * summary generator) rendered into the toolbar bar. Pinning both groups to the
 * same width keeps the divider and the Copy/Export pair from jumping sideways
 * when the user switches «Транскрипт / Конспект». The value tracks the wider of
 * the two groups in its full-label Russian state (the summary generator with
 * «Пересоздать» and all five buttons) and applies only from the 40rem container
 * breakpoint up, where both groups show full labels; below it the summary group
 * collapses to icons and pinning would overflow narrow layouts.
 *
 * Measured with Source Sans 3 at the ≥40rem breakpoint (Russian labels):
 * summary group («Пересоздать» + Найти/Русский/Модель/Шаблон) ≈ 497.6px,
 * transcript group (Спикеры/Найти/Повтор/Запись/Выделить) ≈ 488.1px — hence
 * 498px pins both groups to the same rendered width. Re-measure if the
 * labels, button set or paddings change.
 */
export const TOOLBAR_MODE_GROUP_MIN_WIDTH = '@[40rem]:min-w-[498px]';
