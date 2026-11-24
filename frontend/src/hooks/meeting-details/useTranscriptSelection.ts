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
 * Ticket 04 wires both directions of mode exclusivity through this hook:
 * the page calls `exitSelection` when Find/Replace opens, and passes it as
 * the view's exit listener so the pencil closes the mode too.
 */
export interface UseTranscriptSelectionReturn {
    /** Whether «Выделение» mode is on: rows show checkboxes. */
    isSelecting: boolean;
    /** Selected segment ids, in selection order. */
    selectedIds: string[];
    /** Counter for «Удалить (N)». */
    selectedCount: number;
    /** Turn the mode on and off from the toolbar button. */
    toggleSelection: () => void;
    /** Leave the mode and clear the id set (Esc, find opening, unmount). */
    exitSelection: () => void;
    /** Flip one row's checkbox. */
    toggleSelected: (transcriptId: string) => void;
    /** Replace the whole id set — ticket 03's by-speaker and the post-batch clear. */
    setSelectedIds: (transcriptIds: string[]) => void;
    /**
     * Toggle button form of «выделить всё видимое» (ticket 03): the caller
     * hands the ids of the LOADED segments (page-window honesty — speaker
     * counts from the panel cover the whole meeting and would lie in
     * «Удалить (N)»). Everything visible is already marked → clear;
     * otherwise complete the selection, keeping already-selected rows in
     * their selection-order slot so the Shift anchor stays the id the user
     * really touched last.
     */
    toggleAllVisible: (transcriptIds: string[]) => void;
    /**
     * File-manager Shift-click (ticket 03): select the run from the last
     * selected row to `targetId`, in the list's own order (`orderedIds`),
     * inclusive. Without an anchor row there is no range: the click marks
     * only the target.
     */
    rangeSelectTo: (targetId: string, orderedIds: string[]) => void;
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

    const toggleAllVisible = useCallback((transcriptIds: string[]) => {
        // The button answers «everything visible»: another press clears.
        // A partial selection (checkboxes before/after the press) completes
        // it instead — the clear only ever answers a fully-marked list.
        setSelectedIdsState(prev => {
            const everythingMarked = transcriptIds.length > 0
                && transcriptIds.every(id => prev.includes(id));
            if (everythingMarked) return [];
            const visible = new Set(transcriptIds);
            const kept = prev.filter(id => visible.has(id));
            const added = transcriptIds.filter(id => !prev.includes(id));
            return [...kept, ...added];
        });
    }, []);

    const rangeSelectTo = useCallback((targetId: string, orderedIds: string[]) => {
        // File-manager Shift-click: the run spans from the last touched row
        // to the clicked one, in the list's own order, inclusive. Without
        // an anchor there is no range, so the click marks only the target.
        setSelectedIdsState(prev => {
            const anchor = prev.length > 0 ? prev[prev.length - 1] : undefined;
            if (anchor === undefined) {
                return prev.includes(targetId) ? prev : [...prev, targetId];
            }
            const anchorIndex = orderedIds.indexOf(anchor);
            const targetIndex = orderedIds.indexOf(targetId);
            if (anchorIndex === -1 || targetIndex === -1) {
                // The anchor or the target fell outside the loaded window
                // (a page reload can swap rows underneath): single toggle.
                return prev.includes(targetId)
                    ? prev.filter(id => id !== targetId)
                    : [...prev, targetId];
            }
            const from = Math.min(anchorIndex, targetIndex);
            const to = Math.max(anchorIndex, targetIndex);
            // Walk from the anchor to the target so the selection order
            // (and the next Shift anchor) follows the click direction.
            const range: string[] = [];
            if (anchorIndex <= targetIndex) {
                for (let i = from; i <= to; i++) range.push(orderedIds[i]);
            } else {
                for (let i = from; i <= to; i++) range.push(orderedIds[to - (i - from)]);
            }
            const next = [...prev];
            for (const id of range) {
                if (!next.includes(id)) next.push(id);
            }
            return next;
        });
    }, []);

    return {
        isSelecting,
        selectedIds,
        selectedCount: selectedIds.length,
        toggleSelection,
        exitSelection,
        toggleSelected,
        setSelectedIds,
        toggleAllVisible,
        rangeSelectTo,
    };
}
