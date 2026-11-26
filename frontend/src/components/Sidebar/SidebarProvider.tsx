'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { maxNotesColumnWidth, readNotesColumnWidth } from '@/lib/notes-column-width';
import { isNotesColumnRoute } from '@/lib/layout-offset';
import type { MeetingSpeaker, SummaryProcessResponse } from '@/types';



export interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
  /** RFC3339 moment of the meeting itself (start of the recording); absent while unknown. */
  recordedAt?: string;
  /** Meeting length in seconds; absent while unknown. */
  durationSeconds?: number;
}

export interface CurrentMeeting {
  id: string;
  title: string;
  recordedAt?: string;
  durationSeconds?: number;
}

/**
 * What the notes column shows. Only the notes mode exists today; the type is
 * the extension point for future modes, each with its own column content.
 */
export type ColumnMode = 'notes';

// Search result type for transcript search
interface TranscriptSearchResult {
  id: string;
  title: string;
  matchContext: string;
  timestamp: string;
}

interface SummaryPoll {
  processId: string;
  timer: NodeJS.Timeout;
  inFlight: boolean;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  /** Active notes-column mode; the column itself cannot be hidden. */
  columnMode: ColumnMode;
  /**
   * Whether the notes column currently takes layout space. Derived from the
   * route: the column shows only on the notes routes (meeting page, legacy
   * notes); on home, settings, feedback and during recording it is hidden
   * and the content spans the width it would use.
   */
  isNotesColumnVisible: boolean;
  /** Notes-column width in px; restored from storage on launch, persisted by the column's resize handle. */
  notesColumnWidth: number;
  setNotesColumnWidth: (width: number) => void;
  /**
   * True while the column's resize handle is dragged. The column and every
   * offset consumer drop their width/margin transitions for the drag, so the
   * layout tracks the cursor instead of animating behind it.
   */
  isNotesColumnResizing: boolean;
  setNotesColumnResizing: (resizing: boolean) => void;
  doodlePath: string | null;
  doodleDate: string | null;
  toggleCollapse: () => void;
  meetings: CurrentMeeting[];
  setMeetings: (meetings: CurrentMeeting[]) => void;
  isMeetingActive: boolean;
  setIsMeetingActive: (active: boolean) => void;
  handleRecordingToggle: () => void;
  searchTranscripts: (query: string) => Promise<void>;
  searchResults: TranscriptSearchResult[];
  isSearching: boolean;
  setServerAddress: (address: string) => void;
  serverAddress: string;
  transcriptServerAddress: string;
  setTranscriptServerAddress: (address: string) => void;
  // Summary polling management
  startSummaryPolling: (
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => void;
  stopSummaryPolling: (meetingId: string, processId?: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;
  /**
   * Number of diarized speakers of a meeting, or `null` while unknown (no
   * diarization, or the backend failed). Resolved on the hover popup's first
   * ask and cached for the sidebar session, so repeated hovers and list
   * scrolling never re-request.
   */
  loadSpeakerCount: (meetingId: string) => Promise<number | null>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(true);
  // The notes mode is the only column mode; no UI switches it yet.
  const [columnMode] = useState<ColumnMode>('notes');
  // The stored width is read lazily on mount; a missing or corrupted value
  // falls back to the default inside the reader.
  const [notesColumnWidth, setNotesColumnWidth] = useState(() => readNotesColumnWidth());
  // Set by the column's resize handle for the duration of a drag; the offset
  // consumers read it to suspend their transitions while the width moves.
  const [isNotesColumnResizing, setNotesColumnResizing] = useState(false);
  const [doodlePath, setDoodlePath] = useState<string | null>(null);
  const [doodleDate, setDoodleDate] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [transcriptServerAddress, setTranscriptServerAddress] = useState('');
  const summaryPollsRef = React.useRef(new Map<string, SummaryPoll>());
  // Speaker counts for the hover popup, resolved lazily on first hover and
  // kept for the lifetime of the sidebar. The promises themselves are cached,
  // so concurrent asks for one meeting share a single request.
  const speakerCountPromisesRef = React.useRef(new Map<string, Promise<number | null>>());

  // Use recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();

  const pathname = usePathname();
  const router = useRouter();

  // The column takes layout space only on the notes routes; everywhere else
  // (home, settings, feedback, recording) it is hidden and the content spans
  // its width. Derived from the route, so it can never disagree with the
  // address bar.
  const isNotesColumnVisible = isNotesColumnRoute(pathname);

  // The width cap is half the viewport. When the window shrinks below the
  // column's current width, the column shrinks with it; a wider window never
  // re-grows the column on its own — the user drags it back out.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onResize = () => {
      setNotesColumnWidth(width => Math.min(width, maxNotesColumnWidth(window.innerWidth)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const sync = () => {
      invoke<string | null>('doodle_sync').then(path => {
        setDoodlePath(path);
        setDoodleDate(new Date().toISOString().slice(0, 10));
      }).catch(() => setDoodlePath(null));
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') sync(); };
    sync();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Extract fetchMeetings as a reusable function
  const fetchMeetings = React.useCallback(async () => {
    if (serverAddress) {
      try {
        const meetings = await invoke('api_get_meetings') as Array<{
          id: string;
          title: string;
          recorded_at?: string | null;
          duration_seconds?: number | null;
        }>;
        // The meeting's own date and length are carried through as they come:
        // an absent value must stay absent so the row can omit it instead of
        // showing a substituted date or a zero.
        const transformedMeetings = meetings.map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          recordedAt: meeting.recorded_at ?? undefined,
          durationSeconds: meeting.duration_seconds ?? undefined,
        }));
        setMeetings(transformedMeetings);
      } catch (error) {
        console.error('Error fetching meetings:', error);
        setMeetings([]);
      }
    }
  }, [serverAddress]);

  useEffect(() => {
    fetchMeetings();
  }, [serverAddress, fetchMeetings]);

  useEffect(() => {
    const fetchSettings = async () => {
      setServerAddress('http://localhost:5167');
      setTranscriptServerAddress('http://127.0.0.1:8178/stream');
    };
    fetchSettings();
  }, []);

  const loadSpeakerCount = React.useCallback((meetingId: string) => {
    const cached = speakerCountPromisesRef.current.get(meetingId);
    if (cached) return cached;
    const request = invoke<MeetingSpeaker[]>('api_get_meeting_speakers', { meetingId })
      .then((speakers) => (Array.isArray(speakers) ? speakers.length : null))
      // A failed request leaves the count unknown for the session: the popup
      // line stays out and the row does not retry on every hover.
      .catch(() => null);
    speakerCountPromisesRef.current.set(meetingId, request);
    return request;
  }, []);

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: t('nav.meetingNotes'),
      type: 'folder' as const,
      children: [
        ...meetings.map(meeting => ({
          id: meeting.id,
          title: meeting.title,
          type: 'file' as const,
          recordedAt: meeting.recordedAt,
          durationSeconds: meeting.durationSeconds,
        }))
      ]
    },
  ];


  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings]);

  // Function to handle recording toggle from sidebar
  const handleRecordingToggle = () => {
    if (!isRecording) {
      // Check if already on home page
      if (pathname === '/') {
        // Already on home - trigger recording directly via custom event
        console.log('Triggering recording from sidebar (already on home page)');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      } else {
        // Not on home - navigate and use auto-start mechanism
        console.log('Navigating to home page with auto-start flag');
        sessionStorage.setItem('autoStartRecording', 'true');
        router.push('/');
      }
    }
    // The actual recording start/stop is handled in the Home component
  };

  // Function to search through meeting transcripts
  const searchTranscripts = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      setIsSearching(true);


      const results = await invoke('api_search_transcripts', { query }) as TranscriptSearchResult[];
      setSearchResults(results);
    } catch (error) {
      console.error('Error searching transcripts:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Summary polling management
  const stopSummaryPolling = React.useCallback((meetingId: string, processId?: string) => {
    const poll = summaryPollsRef.current.get(meetingId);
    if (!poll || (processId && poll.processId !== processId)) {
      return;
    }
    clearInterval(poll.timer);
    summaryPollsRef.current.delete(meetingId);
  }, []);

  const startSummaryPolling = React.useCallback((
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => {
    stopSummaryPolling(meetingId);
    let pollCount = 0;
    const maxPolls = 200;
    const poll = async () => {
      const entry = summaryPollsRef.current.get(meetingId);
      if (!entry || entry.processId !== processId || entry.inFlight) {
        return;
      }
      entry.inFlight = true;
      try {
        pollCount += 1;
        if (pollCount >= maxPolls) {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: 'Summary generation timed out after 15 minutes. Please try again or check your model configuration.',
          });
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
          return;
        }

        const result = await invoke<SummaryProcessResponse>('api_get_summary', { meetingId });
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry || result.start !== processId) {
          return;
        }
        await onUpdate(result);
        if (summaryPollsRef.current.get(meetingId) !== entry) return;
        if (
          result.status === 'completed'
          || result.status === 'error'
          || result.status === 'failed'
          || result.status === 'cancelled'
          || (result.status === 'idle' && pollCount > 1)
        ) {
          stopSummaryPolling(meetingId, processId);
        }
      } catch (error) {
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry) {
          return;
        }
        try {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } catch (callbackError) {
          console.error('Failed to handle summary polling error:', callbackError);
        } finally {
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
        }
      } finally {
        const current = summaryPollsRef.current.get(meetingId);
        if (current === entry) {
          current.inFlight = false;
        }
      }
    };

    const timer = setInterval(() => void poll(), 5000);
    summaryPollsRef.current.set(meetingId, { processId, timer, inFlight: false });
  }, [stopSummaryPolling]);

  useEffect(() => () => {
    summaryPollsRef.current.forEach(({ timer }) => clearInterval(timer));
    summaryPollsRef.current.clear();
  }, []);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      columnMode,
      isNotesColumnVisible,
      notesColumnWidth,
      setNotesColumnWidth,
      isNotesColumnResizing,
      setNotesColumnResizing,
      doodlePath,
      doodleDate,
      toggleCollapse,
      meetings,
      setMeetings,
      isMeetingActive,
      setIsMeetingActive,
      handleRecordingToggle,
      searchTranscripts,
      searchResults,
      isSearching,
      setServerAddress,
      serverAddress,
      transcriptServerAddress,
      setTranscriptServerAddress,
      startSummaryPolling,
      stopSummaryPolling,
      refetchMeetings: fetchMeetings,
      loadSpeakerCount,

    }}>
      {children}
    </SidebarContext.Provider>
  );
}
