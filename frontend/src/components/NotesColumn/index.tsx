'use client';

import React from 'react';

import { useSidebar } from '../Sidebar/SidebarProvider';
import { sidebarWidthPx } from '@/lib/layout-offset';
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
  const { isCollapsed, columnMode, notesColumnWidth } = useSidebar();

  return (
    <aside
      className="fixed top-0 h-screen z-30 bg-white border-r shadow-sm flex flex-col transition-all duration-300"
      style={{ left: sidebarWidthPx(isCollapsed), width: notesColumnWidth }}
    >
      {/* Header spacing mirroring the sidebar, so the search row clears the
          window's traffic-light zone when the sidebar is collapsed. */}
      <div className="flex-shrink-0 h-22" />
      {columnMode === 'notes' && <MeetingList />}
    </aside>
  );
};

export default NotesColumn;
