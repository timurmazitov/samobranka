"use client"
import { useSidebar } from "@/components/Sidebar/SidebarProvider";
import { useState, useEffect, useCallback, Suspense } from "react";
import { MeetingSpeaker, MeetingSummary, SummaryProcessResponse, Transcript } from "@/types";
import PageContent from "./page-content";
import { useRouter, useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { LoaderIcon } from "lucide-react";
import { useConfig } from "@/contexts/ConfigContext";
import { usePaginatedTranscripts } from "@/hooks/usePaginatedTranscripts";
import { useSpeakerNamesResetListener } from "@/hooks/useSpeakerNamesResetListener";
import { useTranscriptUpdatedListener } from "@/hooks/useTranscriptUpdatedListener";
import { parseSummaryContent } from "@/lib/summary-content";

interface MeetingDetailsResponse {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  transcripts: Transcript[];
  folder_path?: string;
  recorded_at?: string | null;
}

function MeetingDetailsContent() {
  const searchParams = useSearchParams();
  const meetingId = searchParams.get('id');
  const source = searchParams.get('source'); // Check if navigated from recording
  const { setCurrentMeeting, refetchMeetings } = useSidebar();
  const { isAutoSummary } = useConfig(); // Get auto-summary toggle state
  const router = useRouter();
  const [meetingDetails, setMeetingDetails] = useState<MeetingDetailsResponse | null>(null);
  const [summaryResponse, setSummaryResponse] = useState<SummaryProcessResponse | null>(null);
  const [meetingSummary, setMeetingSummary] = useState<MeetingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [shouldAutoGenerate, setShouldAutoGenerate] = useState<boolean>(false);
  const [hasCheckedAutoGen, setHasCheckedAutoGen] = useState<boolean>(false);
  const [meetingSpeakers, setMeetingSpeakers] = useState<MeetingSpeaker[]>([]);

  // Use pagination hook for efficient transcript loading
  const {
    metadata,
    segments,
    transcripts,
    isLoading: isLoadingTranscripts,
    isLoadingMore,
    hasMore,
    totalCount,
    loadedCount,
    loadMore,
    loadAllPages,
    refetch,
    refetchMetadata,
    setTranscriptSpeaker,
    setTranscriptText,
    error: transcriptError,
  } = usePaginatedTranscripts({ meetingId: meetingId || '' });

  // Speakers of this meeting, fetched once per meeting and refreshed after any
  // transcript/speaker change so counts stay correct. Paginated transcripts
  // only hold one page, so the list cannot be derived from loaded segments.
  const loadMeetingSpeakers = useCallback(async () => {
    if (!meetingId) {
      setMeetingSpeakers([]);
      return;
    }
    try {
      const speakers = await invoke<MeetingSpeaker[]>('api_get_meeting_speakers', { meetingId });
      setMeetingSpeakers(speakers);
    } catch (err) {
      console.error('Failed to load meeting speakers:', err);
      setMeetingSpeakers([]);
    }
  }, [meetingId]);

  useEffect(() => {
    void loadMeetingSpeakers();
  }, [loadMeetingSpeakers]);

  // Refetch transcripts and the speaker list together: labels and their counts
  // change in the same backend operation.
  const refetchTranscriptsAndSpeakers = useCallback(async () => {
    await Promise.all([refetch(), loadMeetingSpeakers()]);
  }, [refetch, loadMeetingSpeakers]);

  // A single row edit only affects that row (and the per-label counts), so the
  // segment is updated in place instead of reloading the first transcript page.
  const handleSpeakerChanged = useCallback(async (transcriptId: string, label: string | null) => {
    const speakerName = label
      ? meetingSpeakers.find(s => s.label === label)?.speaker_name ?? null
      : null;
    setTranscriptSpeaker(transcriptId, label, speakerName);
    await loadMeetingSpeakers();
  }, [meetingSpeakers, setTranscriptSpeaker, loadMeetingSpeakers]);

  // A text edit changes only that row's text: the pagination hook saves it
  // optimistically and rolls it back on failure, so this callback just awaits
  // that save — a rejection must propagate to the row (its toast) and must
  // not reach the stale-summary hint in page-content. The callback must stay
  // referentially stable so the memoized rows do not re-render on every
  // keystroke elsewhere.
  const handleTextEdited = useCallback(async (transcriptId: string, text: string) => {
    await setTranscriptText(transcriptId, text);
  }, [setTranscriptText]);

  const checkForGemmaModel = useCallback(async (): Promise<boolean> => {
    try {
      const models = await invoke('get_ollama_models', { endpoint: null }) as any[];
      const hasGemma = models.some((m: any) => m.name === 'gemma3:1b');
      console.log('🔍 Checked for gemma3:1b:', hasGemma);
      return hasGemma;
    } catch (error) {
      console.error('❌ Failed to check Ollama models:', error);
      return false;
    }
  }, []);

  // Set up auto-generation - respects DB as source of truth
  const setupAutoGeneration = useCallback(async () => {
    if (hasCheckedAutoGen) return; // Only check once

    // Only auto-generate if navigated from recording
    if (source !== 'recording') {
      console.log('Not from recording navigation, skipping auto-generation');
      setHasCheckedAutoGen(true);
      return;
    }

    // Respect user's auto-summary toggle preference
    if (!isAutoSummary) {
      console.log('Auto-summary is disabled in settings');
      setHasCheckedAutoGen(true);
      return;
    }

    try {
      // Check what's currently in database
      const currentConfig = await invoke('api_get_model_config') as any;

      // If DB already has a model, use it (never override!)
      if (currentConfig && currentConfig.model) {
        console.log('Using existing model from DB:', currentConfig.model);
        setShouldAutoGenerate(true);
        setHasCheckedAutoGen(true);
        return;
      }

      // DB is empty - check if gemma3:1b exists as fallback
      const hasGemma = await checkForGemmaModel();

      if (hasGemma) {
        console.log('💾 DB empty, using gemma3:1b as initial default');

        await invoke('api_save_model_config', {
          provider: 'ollama',
          model: 'gemma3:1b',
          // The legacy settings.whisperModel column stays in the schema but
          // is no longer seeded with a Whisper engine model.
          whisperModel: '',
          apiKey: null,
          ollamaEndpoint: null,
        });

        setShouldAutoGenerate(true);
      } else {
        console.log('⚠️ No model configured and gemma3:1b not found');
      }
    } catch (error) {
      console.error('❌ Failed to setup auto-generation:', error);
    }

    setHasCheckedAutoGen(true);
  }, [hasCheckedAutoGen, checkForGemmaModel, source, isAutoSummary]);

  // Sync meeting metadata from pagination hook to meeting details state
  useEffect(() => {
    if (isLoadingTranscripts || !meetingId || meetingId === 'intro-call' || metadata?.id !== meetingId) {
      // Keep the current view until the selected meeting's first transcript page is ready.
      return;
    }

    if (metadata) {
      console.log('Meeting metadata loaded:', metadata);

      // Build meeting details from metadata and paginated transcripts
      setMeetingDetails({
        id: metadata.id,
        title: metadata.title,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        transcripts: transcripts, // Paginated transcripts from hook
        folder_path: metadata.folder_path, // For retranscription feature
        recorded_at: metadata.recorded_at, // Header date, absent while unknown
      });

      // Sync with sidebar context
      setCurrentMeeting({ id: metadata.id, title: metadata.title });
    }
  }, [metadata, transcripts, meetingId, isLoadingTranscripts, setCurrentMeeting]);

  // Handle transcript loading errors
  useEffect(() => {
    if (transcriptError) {
      console.error('Error loading transcripts:', transcriptError);
      setError(transcriptError);
    }
  }, [transcriptError]);

  // A background diarization pass refreshes the open meeting through the native
  // `transcript-updated` event: the labels are written straight to the database,
  // so the page reloads them unless the user already navigated away.
  useTranscriptUpdatedListener(meetingId, () => {
    void refetchTranscriptsAndSpeakers();
  });

  // A recount of the labels (retranscription, post-recording diarization) can
  // wipe every name; the backend says why and we reload so the names vanish.
  // The speaker list is reloaded together with the transcripts it belongs to.
  useSpeakerNamesResetListener(meetingId, refetchTranscriptsAndSpeakers);

  // The sidebar's edit dialog can change this meeting's title or date while it
  // is open here. Reload so the summary corner, the header and the exports
  // follow. `dateEdited` tells which fields moved: a pure rename changes
  // nothing in the transcripts or the speaker list, so only the metadata is
  // re-read. An event without the flag keeps the old full reload.
  useEffect(() => {
    if (!meetingId || typeof window === 'undefined') return;

    const onMetadataUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId?: string; dateEdited?: boolean }>).detail;
      if (detail?.meetingId && detail.meetingId === meetingId) {
        void (detail.dateEdited === false ? refetchMetadata() : refetch());
      }
    };

    window.addEventListener('meeting-metadata-updated', onMetadataUpdated);
    return () => window.removeEventListener('meeting-metadata-updated', onMetadataUpdated);
  }, [meetingId, refetch, refetchMetadata]);

  // Extract fetchMeetingDetails for use in child components (now refetches via hook)
  const fetchMeetingDetails = useCallback(async () => {
    if (!meetingId || meetingId === 'intro-call') {
      return;
    }

    // The usePaginatedTranscripts hook automatically refetches when meetingId changes
    // This function is kept for compatibility with onMeetingUpdated callback
    console.log('fetchMeetingDetails called - pagination hook will handle refetch');
  }, [meetingId]);

  // Reset states when meetingId changes (prevent race conditions)
  useEffect(() => {
    setMeetingDetails(null);
    setMeetingSummary(null);
    setSummaryResponse(null);
    setError(null);
    setIsLoading(true);
    // Reset auto-generation state to allow new meeting to be checked
    setHasCheckedAutoGen(false);
    setShouldAutoGenerate(false);
  }, [meetingId]);

  useEffect(() => {
    console.log('MeetingDetails useEffect triggered - meetingId:', meetingId);

    if (!meetingId || meetingId === 'intro-call') {
      console.warn('No valid meeting ID in URL - meetingId:', meetingId);
      setError("No meeting selected");
      setIsLoading(false);
      return;
    }

    console.log('Valid meeting ID found, fetching details for:', meetingId);

    setMeetingDetails(null);
    setMeetingSummary(null);
    setSummaryResponse(null);
    setError(null);
    setIsLoading(true);

    let cancelled = false;
    const fetchMeetingSummary = async () => {
      try {
        const response = await invoke<SummaryProcessResponse>('api_get_summary', {
          meetingId,
        });
        if (cancelled) return;
        setSummaryResponse(response);
        const summary = parseSummaryContent(response.data);
        setMeetingSummary(response.status === 'idle' ? null : summary);
      } catch (error) {
        if (cancelled) return;
        console.error('FETCH SUMMARY: Error fetching meeting summary:', error);
        setMeetingSummary(null);
      }
    };

    const loadData = async () => {
      try {
        await fetchMeetingSummary();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadData();
    return () => { cancelled = true; };
  }, [meetingId]);

  // Auto-generation check: runs when meeting is loaded with no summary
  useEffect(() => {
    const checkAutoGen = async () => {
      // Only auto-generate if:
      // 1. We have meeting details
      // 2. No summary exists
      // 3. Meeting has transcripts
      // 4. Haven't checked yet
      if (
        meetingDetails &&
        !isLoading &&
        summaryResponse?.status === 'idle' &&
        meetingSummary === null &&
        meetingDetails.transcripts &&
        meetingDetails.transcripts.length > 0 &&
        !hasCheckedAutoGen
      ) {
        console.log('No summary found, checking for auto-generation...');
        await setupAutoGeneration();
      }
    };

    checkAutoGen();
  }, [meetingDetails, meetingSummary, summaryResponse, isLoading, hasCheckedAutoGen, setupAutoGeneration]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  // Show loading spinner while initial data loads
  if (isLoading || !meetingDetails || meetingDetails.id !== meetingId) {
    return <div className="flex items-center justify-center h-screen">
      <LoaderIcon className="animate-spin size-6 " />
    </div>;
  }

  return <PageContent
    key={meetingId}
    initialSummary={summaryResponse}
    meeting={meetingDetails}
    summaryData={meetingSummary}
    shouldAutoGenerate={shouldAutoGenerate}
    onAutoGenerateComplete={() => setShouldAutoGenerate(false)}
    onMeetingUpdated={async () => {
      // Refetch meeting details to get updated title from backend
      await fetchMeetingDetails();
      // Refetch meetings list to update sidebar
      await refetchMeetings();
    }}
    onRefetchTranscripts={refetchTranscriptsAndSpeakers}
    meetingSpeakers={meetingSpeakers}
    onSpeakerChanged={handleSpeakerChanged}
    onTextEdited={handleTextEdited}
    // Pagination props for efficient transcript loading
    segments={segments}
    hasMore={hasMore}
    isLoadingMore={isLoadingMore}
    totalCount={totalCount}
    loadedCount={loadedCount}
    onLoadMore={loadMore}
    onLoadAllPages={loadAllPages}
  />;
}

export default function MeetingDetails() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <LoaderIcon className="animate-spin size-6" />
      </div>
    }>
      <MeetingDetailsContent />
    </Suspense>
  );
}
