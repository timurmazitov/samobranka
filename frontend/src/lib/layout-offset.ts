// Content offset from the fixed left chrome: one helper for every consumer
// that compensates the sidebar and notes-column widths (main content,
// recording controls, status overlays, find & replace panel) instead of
// hand-written literals. Widths are pixels: the sidebar is Tailwind w-16/w-64
// (4rem/16rem at the default root font size), the column width comes from the
// SidebarProvider state.

export const SIDEBAR_WIDTH_COLLAPSED_PX = 64;
export const SIDEBAR_WIDTH_EXPANDED_PX = 256;

/** The fixed sidebar's current width in px; the notes column starts here. */
export function sidebarWidthPx(sidebarCollapsed: boolean): number {
  return sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED_PX : SIDEBAR_WIDTH_EXPANDED_PX;
}

/**
 * Offset that clears both the sidebar and the notes column: `margin-left`
 * for left-docked content, `margin-right` for right-docked panels.
 */
export function contentOffset(sidebarCollapsed: boolean, notesColumnWidthPx: number): string {
  return `${sidebarWidthPx(sidebarCollapsed) + notesColumnWidthPx}px`;
}
