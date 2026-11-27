'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronDown, ChevronRight, SearchIcon, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

import { useSidebar } from '../Sidebar/SidebarProvider';
import type { CurrentMeeting, SidebarItem } from '../Sidebar/SidebarProvider';
import { MeetingFileItem } from '../Sidebar/MeetingFileItem';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';
import { fromDateTimeInputValue, toDateTimeInputValue } from '@/lib/meeting-datetime';
import { meetingRoute } from '@/lib/meeting-route';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { VisuallyHidden } from "@/components/ui/visually-hidden"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';

/**
 * The meeting list with its search row, hosted by the notes column. Owns
 * everything the list needs to work on its own: the local search query,
 * the delete/edit modals and their handlers, the active-row highlight and
 * the click routing. Rendered by the column, which shows it only on the
 * notes routes.
 */
export function MeetingList() {
  const { t } = useTranslation();
  const router = useRouter();
  const {
    currentMeeting,
    setCurrentMeeting,
    sidebarItems,
    searchTranscripts,
    searchResults,
    isSearching,
    meetings,
    setMeetings,
    refetchMeetings,
    loadSpeakerCount,
  } = useSidebar();

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['meetings']));
  const [searchQuery, setSearchQuery] = useState<string>('');

  // State for edit modal
  const [editModalState, setEditModalState] = useState<{ isOpen: boolean; meetingId: string | null; currentTitle: string }>({
    isOpen: false,
    meetingId: null,
    currentTitle: ''
  });
  const [editingTitle, setEditingTitle] = useState<string>('');
  const [editingDateTime, setEditingDateTime] = useState<string>('');
  /** The field's value on open, so an untouched date is never rewritten. */
  const [initialDateTime, setInitialDateTime] = useState<string>('');

  // Ensure 'meetings' folder is always expanded
  useEffect(() => {
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders]);

  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; itemId: string | null }>({ isOpen: false, itemId: null });

  // Handle search input changes
  const handleSearchChange = useCallback(async (value: string) => {
    setSearchQuery(value);

    // If search query is empty, just return to normal view
    if (!value.trim()) return;

    // Search through transcripts
    await searchTranscripts(value);

    // Make sure the meetings folder is expanded when searching
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders, searchTranscripts]);

  // Combine search results with sidebar items
  const filteredSidebarItems = useMemo(() => {
    if (!searchQuery.trim()) return sidebarItems;

    // If we have search results, highlight matching meetings
    if (searchResults.length > 0) {
      // Get the IDs of meetings that matched in transcripts
      const matchedMeetingIds = new Set(searchResults.map(result => result.id));

      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search results or title match
            const filteredChildren = folder.children.filter(item => {
              // Include if the meeting ID is in our search results
              if (matchedMeetingIds.has(item.id)) return true;

              // Or if the title matches the search query
              return item.title.toLowerCase().includes(searchQuery.toLowerCase());
            });

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return (matchedMeetingIds.has(folder.id) ||
            folder.title.toLowerCase().includes(searchQuery.toLowerCase()))
            ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    } else {
      // Fall back to title-only filtering if no transcript results
      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search query
            const filteredChildren = folder.children.filter(item =>
              item.title.toLowerCase().includes(searchQuery.toLowerCase())
            );

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return folder.title.toLowerCase().includes(searchQuery.toLowerCase()) ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    }
  }, [sidebarItems, searchQuery, searchResults]);


  const handleDelete = async (itemId: string) => {
    console.log('Deleting item:', itemId);

    try {
      await invoke('api_delete_meeting', {
        meetingId: itemId,
      });
      console.log('Meeting deleted successfully');
      const updatedMeetings = meetings.filter((m: CurrentMeeting) => m.id !== itemId);
      setMeetings(updatedMeetings);

      // Show success toast
      toast.success(t('sidebar.meetingDeleted'), {
        description: t('sidebar.meetingDeletedDescription')
      });

      // If deleting the active meeting, navigate to home
      if (currentMeeting?.id === itemId) {
        setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      toast.error(t('sidebar.toast.deleteFailed'), {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleDeleteConfirm = () => {
    if (deleteModalState.itemId) {
      handleDelete(deleteModalState.itemId);
    }
    setDeleteModalState({ isOpen: false, itemId: null });
  };

  // Handle modal editing of meeting name and date
  const handleEditStart = (meetingId: string, currentTitle: string, currentRecordedAt: string | null) => {
    setEditModalState({
      isOpen: true,
      meetingId: meetingId,
      currentTitle: currentTitle
    });
    setEditingTitle(currentTitle);
    setEditingDateTime(toDateTimeInputValue(currentRecordedAt));
    setInitialDateTime(toDateTimeInputValue(currentRecordedAt));
  };

  const handleEditConfirm = async () => {
    const newTitle = editingTitle.trim();
    const meetingId = editModalState.meetingId;

    if (!meetingId) return;

    // Prevent empty titles
    if (!newTitle) {
      toast.error(t('sidebar.toast.titleEmpty'));
      return;
    }

    // The field is the whole truth when it changed: empty means "no date",
    // passed as an empty string so the backend can tell it apart from "not
    // edited". An untouched field is not sent at all, so a pure rename cannot
    // silently truncate the stored moment to the minute.
    const dateEdited = editingDateTime !== initialDateTime;
    const nextRecordedAt = dateEdited
      ? (editingDateTime.trim() ? fromDateTimeInputValue(editingDateTime) : '')
      : null;

    if (dateEdited && editingDateTime.trim() && nextRecordedAt === null) {
      toast.error(t('sidebar.toast.invalidDateTime'));
      return;
    }

    try {
      await invoke('api_save_meeting_title', {
        meetingId: meetingId,
        title: newTitle,
        recordedAt: nextRecordedAt,
      });

      // Update local state so the row reflects the edit immediately. The
      // backend list is refetched below, which also restores the sort order.
      const updatedMeetings = meetings.map((m: CurrentMeeting) =>
        m.id === meetingId
          ? {
            ...m,
            title: newTitle,
            recordedAt: dateEdited ? (nextRecordedAt || undefined) : m.recordedAt,
          }
          : m
      );
      setMeetings(updatedMeetings);

      // Update current meeting if it's the one being edited
      if (currentMeeting?.id === meetingId) {
        setCurrentMeeting({ id: meetingId, title: newTitle });
      }

      // The open meeting page shows the title and the date too; tell it to
      // reload on any successful save. The flag says whether the date moved:
      // a pure rename cannot change the transcripts or the speaker list, so
      // the page can reload nothing but the meeting metadata.
      window.dispatchEvent(new CustomEvent('meeting-metadata-updated', {
        detail: { meetingId, dateEdited }
      }));

      await refetchMeetings();

      toast.success(t('sidebar.meetingUpdated'));

      // Close modal and reset state
      setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
      setEditingTitle('');
      setEditingDateTime('');
      setInitialDateTime('');
    } catch (error) {
      console.error('Failed to update meeting details:', error);
      toast.error(t('sidebar.toast.updateFailed'), {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleEditCancel = () => {
    setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
    setEditingTitle('');
    setEditingDateTime('');
    setInitialDateTime('');
  };

  const toggleFolder = (folderId: string) => {
    // Normal toggle behavior for all folders
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  // Find matching transcript snippet for a meeting item
  const findMatchingSnippet = (itemId: string) => {
    if (!searchQuery.trim() || !searchResults.length) return null;
    return searchResults.find(result => result.id === itemId);
  };

  const renderItem = (item: SidebarItem, depth = 0) => {
    const isExpanded = expandedFolders.has(item.id);
    const paddingLeft = `${depth * 12 + 12}px`;
    const isActive = item.type === 'file' && currentMeeting?.id === item.id;
    const isMeetingItem = item.id.includes('-') && !item.id.startsWith('intro-call');

    // Check if this item has a matching transcript snippet
    const matchingResult = isMeetingItem ? findMatchingSnippet(item.id) : null;
    const hasTranscriptMatch = !!matchingResult;

    return (
      <div key={item.id}>
        <div
          className={`flex items-center transition-all duration-150 group ${item.type === 'folder' && depth === 0
            ? 'p-3 text-lg font-semibold h-10 mx-3 mt-3 rounded-lg'
            : `px-3 py-2 my-0.5 rounded-md text-sm ${isActive ? 'bg-blue-100 text-blue-700 font-medium hover:bg-blue-200' :
              hasTranscriptMatch ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-gray-200/70'
            } cursor-pointer`
            }`}
          style={item.type === 'folder' && depth === 0 ? {} : { paddingLeft }}
          onClick={() => {
            if (item.type === 'folder') {
              toggleFolder(item.id);
            } else {
              setCurrentMeeting({ id: item.id, title: item.title });
              router.push(meetingRoute(item.id));
            }
          }}
        >
          {item.type === 'folder' ? (
            <>
              {item.id === 'meetings' ? (
                <Calendar className="w-4 h-4 mr-2" />
              ) : item.id === 'notes' ? (
                <Calendar className="w-4 h-4 mr-2" />
              ) : null}
              <span className={depth === 0 ? "" : "font-medium"}>{item.title}</span>
              <div className="ml-auto">
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-500" />
                )}
              </div>
              {searchQuery && item.id === 'meetings' && isSearching && (
                <span className="ml-2 text-xs text-blue-500 animate-pulse">{t('common.searching')}</span>
              )}
            </>
          ) : (
            <MeetingFileItem
              title={item.title}
              meetingId={isMeetingItem ? item.id : null}
              recordedAt={item.recordedAt ?? null}
              durationSeconds={item.durationSeconds ?? null}
              matchContext={hasTranscriptMatch ? matchingResult.matchContext : null}
              isMeeting={isMeetingItem}
              loadSpeakerCount={loadSpeakerCount}
              onEdit={() => handleEditStart(item.id, item.title, item.recordedAt ?? null)}
              onDelete={() => setDeleteModalState({ isOpen: true, itemId: item.id })}
            />
          )}
        </div>
        {item.type === 'folder' && isExpanded && item.children && (
          <div className="ml-1">
            {item.children.map(child => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Search row */}
      <div className="flex-shrink-0 px-3 mt-1">
        <div className="relative mb-1">
          <InputGroup >
            <InputGroupInput placeholder={t('sidebar.searchPlaceholder')} value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            {searchQuery &&
              <InputGroupAddon align={'inline-end'}>
                <InputGroupButton
                  onClick={() => handleSearchChange('')}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            }
          </InputGroup>
        </div>
      </div>

      {/* The folder's icon/title header is gone; only the search-in-progress
          hint stays, on the header's old spot above the list. */}
      {searchQuery && isSearching && (
        <div className="flex-shrink-0 flex items-center h-10 mx-3 mt-3 px-3">
          <span className="text-xs text-blue-500 animate-pulse">{t('common.searching')}</span>
        </div>
      )}

      {/* Scrollable meeting items */}
      <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
        {meetings.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-gray-500">
            {t('notesColumn.emptyNotes')}
          </div>
        ) : (
          filteredSidebarItems
            .filter(item => item.type === 'folder' && expandedFolders.has(item.id) && item.children)
            .map(item => (
              <div key={`${item.id}-children`} className="mx-3">
                {item.children!.map(child => renderItem(child, 1))}
              </div>
            ))
        )}
      </div>

      {/* Confirmation Modal for Delete */}
      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        text={t('sidebar.deleteConfirm')}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModalState({ isOpen: false, itemId: null })}
      />

      {/* Edit Meeting Details Modal */}
      <Dialog open={editModalState.isOpen} onOpenChange={(open) => {
        if (!open) handleEditCancel();
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>{t('sidebar.editMeeting')}</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-4">{t('sidebar.editMeeting')}</h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="meeting-title" className="block text-sm font-medium text-gray-700 mb-2">
                  {t('sidebar.meetingTitle')}
                </label>
                <input
                  id="meeting-title"
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleEditConfirm();
                    } else if (e.key === 'Escape') {
                      handleEditCancel();
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder={t('sidebar.meetingTitlePlaceholder')}
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="meeting-date-time" className="block text-sm font-medium text-gray-700 mb-2">
                  {t('sidebar.meetingDateTime')}
                </label>
                <input
                  id="meeting-date-time"
                  type="datetime-local"
                  value={editingDateTime}
                  onChange={(e) => setEditingDateTime(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleEditConfirm();
                    } else if (e.key === 'Escape') {
                      handleEditCancel();
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-2 text-xs text-gray-500">
                  {t('sidebar.meetingDateHint')}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleEditCancel}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleEditConfirm}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              {t('common.save')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default MeetingList;
