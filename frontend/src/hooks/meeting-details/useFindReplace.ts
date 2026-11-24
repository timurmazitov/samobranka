'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptSegmentData } from '@/types';
import { findMatches } from '@/lib/find-matches';

/**
 * One hit of the find & replace panel. Matches are found inside a single
 * transcript segment (ticket 02) or, later, a single summary text block
 * (tickets 04/05) — never across a boundary — so `from`/`to` are UTF-16
 * indices into that one text, exactly as `findMatches` reports them.
 */
export type FindMatchSource = 'transcript' | 'summary';

export interface Match {
    key: string;
    source: FindMatchSource;
    /** Set for transcript matches: the row to highlight and scroll to. */
    segmentId?: string;
    /** Reserved for summary matches: the editor block id (ticket 04). */
    blockId?: string;
    /** Start index in the segment/block text (inclusive). */
    from: number;
    /** End index in the segment/block text (exclusive). */
    to: number;
}

/**
 * Build the combined transcript match list: every loaded segment is scanned
 * in order (findMatches already returns non-overlapping ranges per text), so
 * the panel's flat navigation order is «segments top to bottom». The RAW
 * segment text is the search text — the same string the row shows while the
 * panel is open and what the save commands persist — so highlight ranges are
 * always honest. Summary matches (tickets 04/05) append after these.
 */
export function buildTranscriptMatches(
    segments: TranscriptSegmentData[],
    query: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean },
): Match[] {
    if (!query.trim()) return [];

    const matches: Match[] = [];
    for (const segment of segments) {
        findMatches(segment.text, query, options).forEach((range, index) => {
            matches.push({
                key: `transcript:${segment.id}:${index}`,
                source: 'transcript',
                segmentId: segment.id,
                from: range.from,
                to: range.to,
            });
        });
    }
    return matches;
}

interface UseFindReplaceProps {
    /** The meeting's loaded transcript segments, in display order. */
    segments: TranscriptSegmentData[];
    /**
     * Host action that pulls every remaining segment page into the pagination
     * state (the meeting page wires the pagination hook's `loadAllPages`).
     * Called once on the first panel open so matches cover not-yet-loaded
     * pages too.
     */
    loadAllPages?: () => void | Promise<void>;
}

interface UseFindReplaceReturn {
    open: boolean;
    query: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    /** The combined match list (transcript now, summary added in ticket 04). */
    matches: Match[];
    /** Index into `matches`; -1 while there is nothing to navigate. */
    activeIndex: number;
    /** 1-based position for the counter; 0 when there is no active match. */
    current: number;
    /** Total matches, for the counter's «текущее / всего». */
    total: number;
    /** A non-blank query is typed. Empty query is never an error state. */
    hasQuery: boolean;
    /** Query typed but nothing found: the panel's red «0 / 0» state. */
    noMatches: boolean;
    /** Which field the next open should focus. */
    focusTarget: 'search' | 'replace';
    /** Increments per open so the panel can re-run its focus effect. */
    focusNonce: number;

    setQuery: (query: string) => void;
    setCaseSensitive: (value: boolean) => void;
    setWholeWord: (value: boolean) => void;
    /** Opens the panel; the first open also asks the host to load all pages. */
    openPanel: (options?: { focus?: 'search' | 'replace' }) => void;
    /** Closes the panel and leaves no query or highlight behind. */
    closePanel: () => void;
    /** Cyclic forward navigation; inert without matches. */
    goNext: () => void;
    /** Cyclic backward navigation; inert without matches. */
    goPrev: () => void;
}

/**
 * State owner of the meeting find & replace panel: query and mode toggles,
 * the combined match list, the active position, and open/close. Pure match
 * building lives in `buildTranscriptMatches` on top of `findMatches`, so the
 * toggles' effect on the list is a plain recomputation. Rendering and scroll
 * are the panel's and the transcript view's job; this hook only says which
 * ranges are matches and which one is active.
 */
export function useFindReplace({
    segments,
    loadAllPages,
}: UseFindReplaceProps): UseFindReplaceReturn {
    const [open, setOpen] = useState(false);
    const [query, setQueryState] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [focusTarget, setFocusTarget] = useState<'search' | 'replace'>('search');
    const [focusNonce, setFocusNonce] = useState(0);

    // The panel opens once per page visit and the full load is a one-shot:
    // reopening must not refetch (the rows keep their edited state in the
    // pagination hook).
    const loadAllRequestedRef = useRef(false);

    const matches = useMemo(
        () => buildTranscriptMatches(segments, query, { caseSensitive, wholeWord }),
        [segments, query, caseSensitive, wholeWord],
    );

    // Any new match list — a new query, a toggle, or freshly loaded pages —
    // restarts navigation at the first match; with nothing found there is no
    // active position at all.
    useEffect(() => {
        setActiveIndex(matches.length > 0 ? 0 : -1);
    }, [matches]);

    const openPanel = useCallback((options?: { focus?: 'search' | 'replace' }) => {
        setOpen(true);
        setFocusTarget(options?.focus ?? 'search');
        setFocusNonce(nonce => nonce + 1);
        if (!loadAllRequestedRef.current) {
            loadAllRequestedRef.current = true;
            void loadAllPages?.();
        }
    }, [loadAllPages]);

    // Closing fully disarms the panel: the rows return to their cleaned
    // display and no highlight or query survives the close.
    const closePanel = useCallback(() => {
        setOpen(false);
        setQueryState('');
        setActiveIndex(-1);
    }, []);

    const goNext = useCallback(() => {
        setActiveIndex(index => (matches.length === 0 ? -1 : (index + 1) % matches.length));
    }, [matches.length]);

    const goPrev = useCallback(() => {
        setActiveIndex(index => (matches.length === 0 ? -1 : (index - 1 + matches.length) % matches.length));
    }, [matches.length]);

    const hasQuery = query.trim().length > 0;

    return {
        open,
        query,
        caseSensitive,
        wholeWord,
        matches,
        activeIndex,
        current: activeIndex < 0 ? 0 : activeIndex + 1,
        total: matches.length,
        hasQuery,
        noMatches: hasQuery && matches.length === 0,
        focusTarget,
        focusNonce,
        setQuery: setQueryState,
        setCaseSensitive,
        setWholeWord,
        openPanel,
        closePanel,
        goNext,
        goPrev,
    };
}
