'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useSidebar } from '../Sidebar/SidebarProvider';
import { sidebarWidthPx } from '@/lib/layout-offset';
import { clampNotesColumnWidth, writeNotesColumnWidth } from '@/lib/notes-column-width';
import { MeetingList } from './MeetingList';

/**
 * The column between the sidebar and the content area. It hosts the active
 * column mode's content — today only the notes mode (search row + meeting
 * list); future modes plug into the same switch. The column cannot be
 * closed by a control: it renders only on the notes routes (meeting page,
 * legacy notes) and stays hidden everywhere else — home, settings, feedback
 * and during recording — where the content spans its width. Positioned like
 * the sidebar: fixed, its left edge tracks the sidebar's current width, its
 * own width comes from the provider state.
 */
const NotesColumn: React.FC = () => {
  const { t } = useTranslation();
  const {
    isCollapsed,
    columnMode,
    isNotesColumnVisible,
    notesColumnWidth,
    setNotesColumnWidth,
    isNotesColumnResizing,
    setNotesColumnResizing,
  } = useSidebar();

  // The active drag's teardown lives in a ref so an unmount mid-drag runs it
  // too: listeners off, text selection back, transitions on. The hooks stay
  // above the visibility early-return: the root layout mounts the column for
  // the whole session, so the notes button flips the same instance from
  // hidden to visible — a hook behind the return would change the hook count
  // between those renders and crash React.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  if (!isNotesColumnVisible) return null;

  // Drag-resize without new dependencies: mousedown on the handle arms
  // window-level mousemove/mouseup listeners, so a fast cursor never loses
  // the drag. The width is the drag-start width plus the pointer delta —
  // correct whatever the sidebar's current state. Text selection is
  // suspended for the drag, and the final width is persisted on mouseup.
  // The resizing flag drops the width/margin transitions of the column and
  // every offset consumer for the drag, so the layout tracks the cursor
  // instead of animating behind it; mouseup brings the transitions back.

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault();
    // A re-entrant mousedown ends the previous drag before starting a new one.
    dragCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = notesColumnWidth;
    const body = typeof document !== 'undefined' ? document.body : null;
    const previousUserSelect = body?.style.userSelect ?? '';
    if (body) body.style.userSelect = 'none';
    setNotesColumnResizing(true);

    // The cap is half the viewport, read from the window at each step; it
    // cannot meaningfully change mid-drag.
    function handleMove(moveEvent: MouseEvent) {
      setNotesColumnWidth(clampNotesColumnWidth(startWidth + moveEvent.clientX - startX));
    }
    function handleUp(upEvent: MouseEvent) {
      const finalWidth = clampNotesColumnWidth(startWidth + upEvent.clientX - startX);
      setNotesColumnWidth(finalWidth);
      writeNotesColumnWidth(finalWidth);
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (body) body.style.userSelect = previousUserSelect;
      setNotesColumnResizing(false);
      dragCleanupRef.current = null;
    }
    dragCleanupRef.current = cleanup;
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <aside
      className={`fixed top-0 h-screen z-30 bg-white border-r shadow-sm flex flex-col${isNotesColumnResizing ? '' : ' transition-all duration-300'}`}
      style={{ left: sidebarWidthPx(isCollapsed), width: notesColumnWidth }}
    >
      {/* Header spacing mirroring the sidebar, so the search row clears the
          window's traffic-light zone when the sidebar is collapsed. */}
      <div className="flex-shrink-0 h-22" />
      {columnMode === 'notes' && <MeetingList />}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('notesColumn.resizeNotesColumn')}
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize transition-colors hover:bg-gray-300 active:bg-gray-400"
      />
    </aside>
  );
};

export default NotesColumn;
