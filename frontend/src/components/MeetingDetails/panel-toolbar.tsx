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
