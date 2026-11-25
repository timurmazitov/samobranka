import { useState, useCallback, useRef, useEffect } from 'react';
import { MeetingSummary, Summary, Transcript } from '@/types';
import { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { hasVisibleSummaryContent } from '@/lib/summary-content';

interface UseMeetingDataProps {
  meeting: any;
  summaryData: MeetingSummary | null;
  onMeetingUpdated?: () => Promise<void>;
}

export function useMeetingData({ meeting, summaryData, onMeetingUpdated }: UseMeetingDataProps) {
  // State
  // Use prop directly since summary generation fetches transcripts independently
  const transcripts = meeting.transcripts;
  const [meetingTitle, setMeetingTitle] = useState<string>(meeting.title || '+ New Call');
  const [aiSummary, setAiSummary] = useState<MeetingSummary | null>(summaryData);

  // Ref for BlockNoteSummaryView
  const blockNoteSummaryRef = useRef<BlockNoteSummaryViewRef>(null);

  // Sidebar context
  const { setCurrentMeeting, setMeetings, meetings: sidebarMeetings } = useSidebar();

  // Sync aiSummary state when summaryData prop changes (fixes display of fetched summaries)
  useEffect(() => {
    console.log('[useMeetingData] Syncing summary data from prop:', summaryData ? 'present' : 'null');
    setAiSummary(summaryData);
  }, [summaryData]); // Only trigger when parent prop changes, not when aiSummary changes

  // Sync meetingTitle state when the meeting data carries a different title
  // (e.g. after a sidebar rename reloads the metadata), so the title the user
  // sees and the title the exports write are always the same current value.
  // Compares before set and skips an empty source: the auto-title
  // `updateMeetingTitle` just applied is never rolled back while the backend
  // metadata has not caught up yet (the sync converges once it does).
  useEffect(() => {
    const sourceTitle = meeting.title;
    if (!sourceTitle) return;
    setMeetingTitle(prev => (prev === sourceTitle ? prev : sourceTitle));
  }, [meeting.title]); // Only trigger when the source value changes, not when meetingTitle changes

  const handleSummaryChange = useCallback((newSummary: Summary) => {
    setAiSummary(newSummary);
  }, []);



  const handleSaveSummary = useCallback(async (summary: MeetingSummary) => {
    if (!hasVisibleSummaryContent(summary)) {
      throw new Error('Summary contains no visible content to save.');
    }

    const formattedSummary = 'markdown' in summary || 'summary_json' in summary
      ? summary
      : { MeetingName: meetingTitle, ...summary };
    await invokeTauri('api_save_meeting_summary', {
      meetingId: meeting.id,
      summary: formattedSummary,
    });
  }, [meeting.id, meetingTitle]);

  // Update meeting title from external source (e.g., AI summary)
  const updateMeetingTitle = useCallback((newTitle: string) => {
    console.log('📝 Updating meeting title to:', newTitle);
    setMeetingTitle(newTitle);
    // Keep the row's own date and length: a rename must not blank them.
    const updatedMeetings = sidebarMeetings.map((m: CurrentMeeting) =>
      m.id === meeting.id ? { ...m, title: newTitle } : m
    );
    setMeetings(updatedMeetings);
    setCurrentMeeting({ id: meeting.id, title: newTitle });
  }, [meeting.id, sidebarMeetings, setMeetings, setCurrentMeeting]);

  return {
    // State
    transcripts,
    meetingTitle,
    aiSummary,
    blockNoteSummaryRef,

    // Setters
    setMeetingTitle,
    setAiSummary,

    // Handlers
    handleSummaryChange,
    handleSaveSummary,
    updateMeetingTitle,
  };
}
