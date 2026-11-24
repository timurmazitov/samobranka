'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useMemo, useState, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { MeetingSpeaker, TranscriptSegmentData } from "@/types";
import {
    formatRecordingTime,
    formatSpeakerDisplayLabel,
    isDiarizationSpeakerLabel,
    orderMeetingSpeakersForChip,
} from "@/lib/transcript-format";
import '@/i18n';

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    /**
     * Speakers of this meeting (label + assigned name). When provided and
     * non-empty, a diarized row's chip becomes a dropdown that reassigns
     * that single row. The live panel passes nothing, so it stays inert.
     */
    meetingSpeakers?: MeetingSpeaker[];
    /** Called after a row's speaker was changed and refetched from the backend. */
    onSpeakerChange?: (transcriptId: string, label: string | null) => void | Promise<void>;
    /**
     * Called after a row's text was saved; the meeting page applies it to the
     * pagination state. The live panel passes nothing, so rows stay inert.
     */
    onTextEdited?: (transcriptId: string, text: string) => void | Promise<void>;
    /**
     * Whether a diarization pass is running for this meeting. The meeting page
     * reads it from the shared pass store; rows fold it into the edit gate so
     * an edit cannot race the pass's row reload.
     */
    isDiarizing?: boolean;
}

// Mirrors the Rust `normalize_transcript_text`: whitespace runs (newlines and
// tabs from pastes included) collapse to single spaces and the ends trim.
// The repository stays authoritative; normalizing here too keeps the
// optimistic value identical to what the database will store.
function normalizeTranscriptText(text: string): string {
    return text.split(/\s+/).filter(Boolean).join(' ');
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Display label for a meeting speaker used in the row dropdown. Falls back to
// `Speaker N` (taken from the label suffix) when the label has no name.
function formatMeetingSpeakerLabel(speaker: MeetingSpeaker): string {
    return formatSpeakerDisplayLabel(speaker.label, speaker.speaker_name ?? undefined)
        ?? speaker.label;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    speaker,
    speakerName,
    isStreaming,
    showConfidence,
    meetingSpeakers,
    onSpeakerChange,
    allowSpeakerEdit,
    onTextEdited,
    allowTextEdit,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    speaker?: string;
    speakerName?: string;
    isStreaming: boolean;
    showConfidence: boolean;
    meetingSpeakers?: MeetingSpeaker[];
    onSpeakerChange?: (transcriptId: string, label: string | null) => void | Promise<void>;
    /** False while recording and when the host does not support row edits. */
    allowSpeakerEdit: boolean;
    /** Called after the row's text was saved; absent on the live panel. */
    onTextEdited?: (transcriptId: string, text: string) => void | Promise<void>;
    /** False while recording; text edits exist only on the meeting page. */
    allowTextEdit: boolean;
}) {
    const { t } = useTranslation();

    // Optimistic text state, mirroring the speaker override below: the saved
    // value shows as soon as the backend accepted it, cleared when the page's
    // state delivers the new text (or on failure).
    const [textOverride, setTextOverride] = useState<string | null>(null);
    useEffect(() => {
        setTextOverride(null);
    }, [text]);
    const effectiveText = textOverride ?? text;
    const displayText =
        cleanStopWords(effectiveText) || (effectiveText.trim() === '' ? t('transcript.silence') : effectiveText);

    // The inline editor: a single-line auto-resizing textarea in place of the
    // text, following EditableTitle. It opens only from the hover pencil and
    // is seeded from the RAW text — never the filler-cleaned display — so
    // saving does not silently drop what the user saw.
    const [isEditing, setIsEditing] = useState(false);
    // A mirror of isEditing in a ref: a browser fires focusout when the
    // focused textarea unmounts, and that stale blur handler still closes over
    // the old draft. The ref — shared by every closure of the open editor —
    // says whether an editor is actually open right now.
    const editingRef = useRef(false);
    const [draft, setDraft] = useState('');
    const draftRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (draftRef.current && isEditing) {
            draftRef.current.style.height = 'auto';
            draftRef.current.style.height = `${draftRef.current.scrollHeight}px`;
        }
    }, [draft, isEditing]);

    // The pencil exists only where an editor has a host: the meeting page
    // passes a callback and opens the gate outside recording and streaming.
    const canEditText = allowTextEdit && !!onTextEdited && !isStreaming;

    const saveDraft = async () => {
        if (!onTextEdited || !editingRef.current) return;
        // Close the editor for every save path first: Enter, blur and a late
        // focusout from the unmount all land here, and only the first call —
        // the one that found the editor open — may save.
        editingRef.current = false;
        setIsEditing(false);
        const normalized = normalizeTranscriptText(draft);
        // An unchanged line stores nothing: a no-op Enter must not bump the
        // meeting. An empty draft does reach the backend, which is the
        // authority that rejects it, so the user gets the error toast.
        if (normalized && normalized === text) return;

        // Never optimistically blank the row while the backend decides.
        if (normalized) setTextOverride(normalized);
        try {
            await invoke('api_update_transcript_text', { transcriptId: id, text: normalized });
            await onTextEdited(id, normalized);
        } catch (error) {
            setTextOverride(null);
            toast.error(t('transcript.updateTextFailed'), { description: String(error) });
        }
    };

    // A diarization pass that starts mid-edit must not drop the draft: when
    // the gate closes under an open editor, the draft goes through the same
    // save path as Enter and the editor closes. The effect only watches the
    // gate, so the save lands on the single transition into the closed gate
    // and never loops; an untouched draft closes without a command.
    useEffect(() => {
        if (!allowTextEdit && isEditing) {
            void saveDraft();
        }
        // The gate transition is the trigger; draft and callback are read
        // from the render that flipped it, which is the current draft.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allowTextEdit]);

    // Optimistic row state: set as soon as the user picks an item, cleared
    // once the refetched segment arrives (or on failure).
    const [override, setOverride] = useState<{ speaker?: string; speakerName?: string } | null>(null);
    useEffect(() => {
        setOverride(null);
    }, [speaker, speakerName]);

    const effectiveSpeaker = override ? override.speaker : speaker;
    const effectiveSpeakerName = override ? override.speakerName : speakerName;
    const speakerLabel = formatSpeakerDisplayLabel(effectiveSpeaker, effectiveSpeakerName);

    // The dropdown exists only on the meeting page: the live panel passes no
    // speaker list, and a meeting without labels has nothing to pick.
    // `mic`/`system`/free-form values are not diarization labels, so they stay
    // inert even when the list is present. A row without a label is editable —
    // its current value is "No speaker".
    const canReassign = !effectiveSpeaker || isDiarizationSpeakerLabel(effectiveSpeaker);
    const interactive = allowSpeakerEdit
        && !!onSpeakerChange
        && (meetingSpeakers?.length ?? 0) > 0
        && canReassign;

    const handleSelect = async (label: string | null) => {
        if (!onSpeakerChange) return;
        if (label === (effectiveSpeaker ?? null)) return;

        const selected = label
            ? meetingSpeakers?.find(s => s.label === label)
            : undefined;
        setOverride({ speaker: label ?? undefined, speakerName: selected?.speaker_name ?? undefined });

        try {
            await invoke('api_set_transcript_speaker', { transcriptId: id, label });
            await onSpeakerChange(id, label);
        } catch (error) {
            setOverride(null);
            toast.error(t('transcript.updateSpeakerFailed'), { description: String(error) });
        }
    };

    const chipClassName = "inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700";
    const noSpeakerChipClassName = "inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500";

    const chipTitle = effectiveSpeaker
        ? t('transcript.speakerAttributedDiarization', { speaker: effectiveSpeaker })
        : t('transcript.noSpeakerAttributed');

    const chip = interactive ? (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`${speakerLabel ? chipClassName : noSpeakerChipClassName} cursor-pointer hover:bg-indigo-100`}
                    title={t('transcript.speakerChipClickToChange', { title: chipTitle })}
                >
                    {speakerLabel ?? t('transcript.noSpeaker')}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {meetingSpeakers?.map(item => {
                    const selected = item.label === effectiveSpeaker;
                    return (
                        <DropdownMenuItem
                            key={item.label}
                            onSelect={() => { void handleSelect(item.label); }}
                            className="flex items-center justify-between gap-2"
                        >
                            <span>{formatMeetingSpeakerLabel(item)}</span>
                            {selected && <Check className="h-4 w-4 text-green-600" />}
                        </DropdownMenuItem>
                    );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    onSelect={() => { void handleSelect(null); }}
                    className="flex items-center justify-between gap-2"
                >
                    <span>{t('transcript.noSpeaker')}</span>
                    {!effectiveSpeaker && <Check className="h-4 w-4 text-green-600" />}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    ) : speakerLabel ? (
        <span className={chipClassName} title={chipTitle}>
            {speakerLabel}
        </span>
    ) : null;

    return (
        <div id={`segment-${id}`} className="mb-3">
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                    </TooltipContent>
                </Tooltip>
                <div className="flex-1">
                    {chip && (
                        <div className="mb-1">
                            {chip}
                        </div>
                    )}
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        </div>
                    ) : isEditing ? (
                        <textarea
                            ref={draftRef}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => { void saveDraft(); }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    // Single-line semantics: a transcript stays one
                                    // logical line, so even Shift+Enter never inserts
                                    // a newline (unlike EditableTitle).
                                    e.preventDefault();
                                    if (!e.shiftKey) {
                                        void saveDraft();
                                    }
                                } else if (e.key === 'Escape') {
                                    // Cancel: leave the editor without saving,
                                    // the stored text was never touched. Closing
                                    // through editingRef means a focusout fired
                                    // by the unmount below finds no open editor.
                                    e.preventDefault();
                                    editingRef.current = false;
                                    setIsEditing(false);
                                }
                            }}
                            className="w-full text-base text-gray-800 leading-relaxed bg-gray-50 border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-2 py-1 resize-none overflow-hidden"
                            autoFocus
                            rows={1}
                        />
                    ) : (
                        <div className="group flex items-start gap-1">
                            <p className="flex-1 text-base text-gray-800 leading-relaxed whitespace-pre-wrap">{displayText}</p>
                            {canEditText && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        // Seed from the RAW text, never the cleaned display.
                                        setDraft(text);
                                        editingRef.current = true;
                                        setIsEditing(true);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 hover:bg-gray-100 rounded text-gray-500 flex-shrink-0"
                                    title={t('transcript.editTextTooltip')}
                                >
                                    <svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    meetingSpeakers,
    onSpeakerChange,
    onTextEdited,
    isDiarizing = false,
}) => {
    const { t } = useTranslation();
    // Text edits close while a diarization pass runs: the pass reloads rows,
    // and an open editor or a mid-save would race that reload. The boolean is
    // computed once here so every row takes the same gate in both branches.
    const allowTextEdit = !isRecording && !isDiarizing;
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // One dropdown order for every row; the panel's own speaker order (first
    // appearance) is untouched because the sort works on a copy.
    const dropdownSpeakers = useMemo(
        () => (meetingSpeakers ? orderMeetingSpeakersForChip(meetingSpeakers) : undefined),
        [meetingSpeakers],
    );

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? t('transcript.recordingPaused') : t('transcript.listeningForSpeech')}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? t('transcript.pausedHint') : t('transcript.speakHint')}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">{t('transcript.welcomeTitle')}</p>
                            <p className="text-xs mt-1">{t('transcript.welcomeHint')}</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        speaker={segment.speaker}
                                        speakerName={segment.speaker_name}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        meetingSpeakers={dropdownSpeakers}
                                        onSpeakerChange={onSpeakerChange}
                                        allowSpeakerEdit={!isRecording}
                                        onTextEdited={onTextEdited}
                                        allowTextEdit={allowTextEdit}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">{t('transcript.loadingMore')}</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    {t('transcript.showingOf', { loaded: loadedCount, count: totalCount })}
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">{t('transcript.listening')}</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        speaker={segment.speaker}
                                        speakerName={segment.speaker_name}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        meetingSpeakers={dropdownSpeakers}
                                        onSpeakerChange={onSpeakerChange}
                                        allowSpeakerEdit={!isRecording}
                                        onTextEdited={onTextEdited}
                                        allowTextEdit={allowTextEdit}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">{t('transcript.loadingMore')}</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    {t('transcript.showingOf', { loaded: loadedCount, count: totalCount })}
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">{t('transcript.listening')}</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
