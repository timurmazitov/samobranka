'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';

import { useSidebar } from '../Sidebar/SidebarProvider';
import { sidebarWidthPx } from '@/lib/layout-offset';
import { clampNotesColumnWidth, writeNotesColumnWidth } from '@/lib/notes-column-width';
import { MeetingList } from './MeetingList';

/**
 * The permanent column between the sidebar and the content area. It hosts the
 * active column mode's content — today only the notes mode (search row +
 * meeting list); future modes plug into the same switch. The column cannot be
 * hidden: there is no close control, and the sidebar's mode button only
 * navigates. Positioned like the sidebar: fixed, its left edge tracks the
 * sidebar's current width, its own width comes from the provider state.
 */
const NotesColumn: React.FC = () => {
  const { t } = useTranslation();
  const { isCollapsed, columnMode, notesColumnWidth, setNotesColumnWidth } = useSidebar();

  // Drag-resize without new dependencies: mousedown on the handle arms
  // window-level mousemove/mouseup listeners, so a fast cursor never loses
  // the drag. The width is the drag-start width plus the pointer delta —
  // correct whatever the sidebar's current state. Text selection is
  // suspended for the drag, and the final width is persisted on mouseup.
  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = notesColumnWidth;
    const body = typeof document !== 'undefined' ? document.body : null;
    const previousUserSelect = body?.style.userSelect ?? '';
    if (body) body.style.userSelect = 'none';

    const handleMove = (moveEvent: MouseEvent) => {
      setNotesColumnWidth(clampNotesColumnWidth(startWidth + moveEvent.clientX - startX));
    };
    const handleUp = (upEvent: MouseEvent) => {
      const finalWidth = clampNotesColumnWidth(startWidth + upEvent.clientX - startX);
      setNotesColumnWidth(finalWidth);
      writeNotesColumnWidth(finalWidth);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (body) body.style.userSelect = previousUserSelect;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <aside
      className="fixed top-0 h-screen z-30 bg-white border-r shadow-sm flex flex-col transition-all duration-300"
      style={{ left: sidebarWidthPx(isCollapsed), width: notesColumnWidth }}
    >
      {/* Header spacing mirroring the sidebar, so the search row clears the
          window's traffic-light zone when the sidebar is collapsed. */}
      <div className="flex-shrink-0 h-22" />
      {columnMode === 'notes' && <MeetingList />}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resizeNotesColumn')}
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize transition-colors hover:bg-gray-300 active:bg-gray-400"
      />
    </aside>
  );
};

export default NotesColumn;
