// Content offset from the fixed sidebar: one helper for every consumer that
// compensates the sidebar width (main content, recording controls, status
// overlays, find & replace panel) instead of four hand-written literals. The
// values are the sidebar's own widths — 4rem collapsed, 16rem expanded. The
// upcoming notes column (spec: notes-column) will extend this computation
// with the column width in one place.

export function contentOffset(sidebarCollapsed: boolean): '4rem' | '16rem' {
  return sidebarCollapsed ? '4rem' : '16rem';
}
