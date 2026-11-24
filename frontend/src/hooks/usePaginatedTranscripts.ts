import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Transcript, MeetingMetadata, PaginatedTranscriptsResponse, TranscriptSegmentData } from "@/types";
import { normalizeTranscriptText } from "@/lib/transcript-format";

const DEFAULT_PAGE_SIZE = 100;

interface UsePaginatedTranscriptsProps {
    meetingId: string | null;
    /** Optional initial timestamp (in seconds) from URL for loading the correct page */
    initialTimestamp?: number;
}

interface UsePaginatedTranscriptsReturn {
    metadata: MeetingMetadata | null;
    segments: TranscriptSegmentData[];
    transcripts: Transcript[];
    isLoading: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    totalCount: number;
    loadedCount: number;
    error: string | null;

    // Actions
    loadMore: () => Promise<void>;
    /**
     * Load every remaining transcript page (a one-shot drain, not a second
     * state owner): each page goes through the same append/dedupe/offset path
     * as `loadMore`, so the meeting's whole transcript ends up in this hook's
     * state. The find panel opens it once so matches cover all segments.
     */
    loadAllPages: () => Promise<void>;
    reset: () => void;
    refetch: () => Promise<void>;
    /** Reload the meeting row (title/date) without touching the loaded transcript page. */
    refetchMetadata: () => Promise<void>;
    /** Apply a row's speaker edit locally (after the backend accepted it). */
    setTranscriptSpeaker: (transcriptId: string, label: string | null, speakerName?: string | null) => void;
    /**
     * Save a row's text edit: applies the normalized text in place
     * optimistically, then persists it. On failure the row is rolled back to
     * its previous text and the error is rethrown so the caller can toast.
     */
    setTranscriptText: (transcriptId: string, text: string) => Promise<void>;
}

/**
 * Convert Transcript array to TranscriptSegmentData for virtualized display
 */
function convertTranscriptsToSegments(transcripts: Transcript[]): TranscriptSegmentData[] {
    return transcripts.map(t => ({
        id: t.id,
        timestamp: t.audio_start_time ?? 0,
        endTime: t.audio_end_time,
        text: t.text,
        confidence: t.confidence,
        speaker: t.speaker,
        speaker_name: t.speaker_name,
    }));
}

export function usePaginatedTranscripts({
    meetingId,
    initialTimestamp,
}: UsePaginatedTranscriptsProps): UsePaginatedTranscriptsReturn {
    const [metadata, setMetadata] = useState<MeetingMetadata | null>(null);
    const [transcripts, setTranscripts] = useState<Transcript[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const offsetRef = useRef(0);
    const activeMeetingIdRef = useRef<string | null>(null);
    const requestIdRef = useRef(0);
    const isLoadingRef = useRef(false);
    const lastLoadTimeRef = useRef(0); // Debounce protection
    // Mirror of `hasMore` the drain loop can read without a stale closure.
    const hasMoreRef = useRef(false);

    const isCurrentRequest = useCallback((requestId: number) =>
        requestIdRef.current === requestId && activeMeetingIdRef.current === meetingId,
        [meetingId]
    );

    // Reset invalidates pending reads, including same-meeting refetches.
    const reset = useCallback(() => {
        requestIdRef.current += 1;
        isLoadingRef.current = false;
        lastLoadTimeRef.current = 0;
        setMetadata(null);
        setTranscripts([]);
        setTotalCount(0);
        setIsLoading(true);
        setIsLoadingMore(false);
        setHasMore(false);
        hasMoreRef.current = false;
        setError(null);
        offsetRef.current = 0;
    }, []);

    // Load meeting metadata
    const loadMetadata = useCallback(async (requestId: number): Promise<MeetingMetadata | null> => {
        if (!meetingId || !isCurrentRequest(requestId)) return null;

        try {
            const data = await invoke<MeetingMetadata>('api_get_meeting_metadata', {
                meetingId,
            });
            if (!isCurrentRequest(requestId)) return null;
            setMetadata(data);
            return data;
        } catch (err) {
            if (!isCurrentRequest(requestId)) return null;
            console.error('Failed to load meeting metadata:', err);
            setError('Failed to load meeting details');
            return null;
        }
    }, [meetingId, isCurrentRequest]);

    // Load transcripts at specific offset
    const loadTranscriptsAtOffset = useCallback(async (
        requestId: number,
        offset: number,
        append: boolean = true
    ): Promise<Transcript[]> => {
        if (!meetingId || !isCurrentRequest(requestId)) return [];

        try {
            const response = await invoke<PaginatedTranscriptsResponse>(
                'api_get_meeting_transcripts',
                {
                    meetingId,
                    limit: DEFAULT_PAGE_SIZE,
                    offset,
                }
            );

            if (!isCurrentRequest(requestId)) return [];
            const newTranscripts = response.transcripts;

            if (append) {
                setTranscripts(prev => {
                    if (!isCurrentRequest(requestId)) return prev;
                    // Deduplicate by id
                    const existingIds = new Set(prev.map(t => t.id));
                    const uniqueNew = newTranscripts.filter(t => !existingIds.has(t.id));
                    // Sort by audio_start_time
                    return [...prev, ...uniqueNew].sort((a, b) =>
                        (a.audio_start_time ?? 0) - (b.audio_start_time ?? 0)
                    );
                });
            } else {
                setTranscripts(newTranscripts);
            }

            setHasMore(response.has_more);
            hasMoreRef.current = response.has_more;
            setTotalCount(response.total_count);
            offsetRef.current = offset + newTranscripts.length;

            return newTranscripts;
        } catch (err) {
            if (!isCurrentRequest(requestId)) return [];
            console.error('Failed to load transcripts:', err);
            setError('Failed to load transcripts');
            return [];
        }
    }, [meetingId, isCurrentRequest]);

    // Load next page with debounce protection
    const loadMore = useCallback(async () => {
        const requestId = requestIdRef.current;
        if (!isCurrentRequest(requestId)) return;
        const now = Date.now();
        // Debounce: require at least 100ms between calls
        if (now - lastLoadTimeRef.current < 100) {
            return;
        }

        if (isLoadingRef.current || !hasMore || !meetingId || isLoading) return;

        lastLoadTimeRef.current = now;
        isLoadingRef.current = true;
        setIsLoadingMore(true);
        try {
            await loadTranscriptsAtOffset(requestId, offsetRef.current, true);
        } finally {
            if (isCurrentRequest(requestId)) {
                setIsLoadingMore(false);
                isLoadingRef.current = false;
            }
        }
    }, [hasMore, meetingId, loadTranscriptsAtOffset, isLoading, isCurrentRequest]);

    // Drain every remaining page through the same append path `loadMore`
    // uses, so the pagination state stays the single owner of the loaded
    // transcripts. The 100ms debounce does not apply: this is a deliberate
    // one-shot, and a stuck offset (a page that returns nothing new) stops
    // the loop so a backend misreport cannot spin.
    const loadAllPages = useCallback(async () => {
        const requestId = requestIdRef.current;
        if (!isCurrentRequest(requestId) || !meetingId) return;

        while (isCurrentRequest(requestId) && hasMoreRef.current) {
            const offset = offsetRef.current;
            await loadTranscriptsAtOffset(requestId, offset, true);
            if (offsetRef.current === offset) break;
        }
    }, [meetingId, loadTranscriptsAtOffset, isCurrentRequest]);

    // Force refetch of data (e.g., after retranscription)
    const refetch = useCallback(async () => {
        if (!meetingId || activeMeetingIdRef.current !== meetingId) return;

        reset();
        const requestId = requestIdRef.current;
        try {
            await loadMetadata(requestId);
            await loadTranscriptsAtOffset(requestId, 0, false);
        } finally {
            if (isCurrentRequest(requestId)) setIsLoading(false);
        }
    }, [meetingId, reset, loadMetadata, loadTranscriptsAtOffset, isCurrentRequest]);

    // Reload only the meeting metadata, leaving the loaded transcript page
    // untouched: a sidebar rename changes nothing in the transcripts, so the
    // open page re-reads just the row behind the header.
    const refetchMetadata = useCallback(async () => {
        if (!meetingId || activeMeetingIdRef.current !== meetingId) return;

        await loadMetadata(requestIdRef.current);
    }, [meetingId, loadMetadata]);

    // A new meeting or effect lifetime owns its own requests.
    useEffect(() => {
        activeMeetingIdRef.current = meetingId;
        if (meetingId) {
            void refetch();
        } else {
            reset();
        }

        return () => {
            requestIdRef.current += 1;
            activeMeetingIdRef.current = null;
        };
    }, [meetingId, reset, refetch]);

    // Convert to segments (memoized)
    const segments = useMemo(() =>
        convertTranscriptsToSegments(transcripts),
        [transcripts]
    );

    // Keep a row edit visible without waiting for the refetch: the chip reads
    // the name from the segment, which the backend does not recompute for us.
    const setTranscriptSpeaker = useCallback((
        transcriptId: string,
        label: string | null,
        speakerName?: string | null,
    ) => {
        setTranscripts(prev => prev.map(t => (
            t.id === transcriptId
                ? { ...t, speaker: label ?? undefined, speaker_name: speakerName ?? undefined }
                : t
        )));
    }, []);

    // A text edit changes only the row's text; timings and speaker stay. The
    // save is optimistic: the normalized text shows at once, the row reverts
    // to the text this mirror holds if the backend rejects the write, and the
    // error rethrows so the row can toast. The mirror (not the state closure)
    // keeps this callback identity-stable for the memoized rows.
    const transcriptsRef = useRef<Transcript[]>([]);
    useEffect(() => {
        transcriptsRef.current = transcripts;
    }, [transcripts]);

    const setTranscriptText = useCallback(async (transcriptId: string, text: string) => {
        const normalized = normalizeTranscriptText(text);
        // Never optimistically blank a row: the repository is the authority
        // that rejects an empty line, and until it answers the user keeps
        // seeing the previous text.
        const previous = transcriptsRef.current.find(t => t.id === transcriptId)?.text;
        const applied = normalized !== '' && previous !== undefined;
        if (applied) {
            setTranscripts(prev => prev.map(t => (
                t.id === transcriptId ? { ...t, text: normalized } : t
            )));
        }

        try {
            await invoke('api_update_transcript_text', { transcriptId, text: normalized });
        } catch (error) {
            if (applied && previous !== undefined) {
                setTranscripts(prev => prev.map(t => (
                    t.id === transcriptId ? { ...t, text: previous } : t
                )));
            }
            throw error;
        }
    }, []);

    return {
        metadata,
        segments,
        transcripts,
        isLoading,
        isLoadingMore,
        hasMore,
        totalCount,
        loadedCount: transcripts.length,
        error,
        loadMore,
        loadAllPages,
        reset,
        refetch,
        refetchMetadata,
        setTranscriptSpeaker,
        setTranscriptText,
    };
}
