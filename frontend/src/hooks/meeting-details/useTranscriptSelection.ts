import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Ephemeral selection state of the transcript segment list (ticket 02).
 *
 * The owner is the meeting page (page-content), mirroring how it owns the
 * find panel's open state — the view stays shared with the live recording
 * page, which has no selection mode. The spec pins the lifetime: the id set
 * is component state, cleared when the mode closes AND when the meeting
 * changes, and it never reaches storage.
 *
 * Ticket 04 hooks both directions of mode exclusivity here: it will call
 * `exitSelection` when Find/Replace opens and pass an enter/exit listener so
 * the pencil closes the mode too. That is why enter/exit are separate
 * callbacks from `toggleSelection`.
 */
export interface UseTranscriptSelectionReturn {
    /** Whether «Выделение» mode is on: rows show checkboxes. */
    isSelecting: boolean;
    /** Selected segment ids, in selection order. */
    selectedIds: string[];
    /** Counter for «Удалить (N)». */
    selectedCount: number;
    isSelected: (transcriptId: string) => boolean;
    /** Turn the mode on and off from the toolbar button. */
    toggleSelection: () => void;
    /** Turn the mode on, always from an empty selection. */
    enterSelection: () => void;
    /** Leave the mode and clear the id set (Esc, find opening, unmount). */
    exitSelection: () => void;
    /** Flip one row's checkbox. */
    toggleSelected: (transcriptId: string) => void;
    /** Replace the whole id set — ticket 03's «выделить всё видимое» and by-speaker. */
    setSelectedIds: (transcriptIds: string[]) => void;
}

export function useTranscriptSelection(
    meetingId: string | null | undefined,
): UseTranscriptSelectionReturn {
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectedIds, setSelectedIdsState] = useState<string[]>([]);

    // Meeting isolation without a meeting-keyed set: the ids are only ever
    // meaningful while the SAME meeting's page holds the mode. A change of
    // meetingId drops both the mode and the ids, so a delete cannot carry
    // over to the newly opened meeting even if the page does not remount.
    const meetingIdRef = useRef(meetingId);
    useEffect(() => {
        if (meetingIdRef.current !== meetingId) {
            meetingIdRef.current = meetingId;
            setIsSelecting(false);
            setSelectedIdsState([]);
        }
    }, [meetingId]);

    // The unmount path needs no extra code: the state dies with the owner
    // (the page remounts per meeting through page.tsx's key={meetingId}).

    const isSelected = useCallback((transcriptId: string) =>
        selectedIds.includes(transcriptId),
        [selectedIds]
    );

    const enterSelection = useCallback(() => {
        setIsSelecting(true);
        setSelectedIdsState([]);
    }, []);

    const exitSelection = useCallback(() => {
        setIsSelecting(false);
        setSelectedIdsState([]);
    }, []);

    const toggleSelection = useCallback(() => {
        // Leaving the mode always drops the ids; entering always starts from
        // an empty selection, so a half-finished earlier selection never
        // resurfaces.
        setIsSelecting(prev => !prev);
        setSelectedIdsState([]);
    }, []);

    const toggleSelected = useCallback((transcriptId: string) => {
        setSelectedIdsState(prev =>
            prev.includes(transcriptId)
                ? prev.filter(id => id !== transcriptId)
                : [...prev, transcriptId]
        );
    }, []);

    const setSelectedIds = useCallback((transcriptIds: string[]) => {
        setSelectedIdsState(Array.from(new Set(transcriptIds)));
    }, []);

    return {
        isSelecting,
        selectedIds,
        selectedCount: selectedIds.length,
        isSelected,
        toggleSelection,
        enterSelection,
        exitSelection,
        toggleSelected,
        setSelectedIds,
    };
}
