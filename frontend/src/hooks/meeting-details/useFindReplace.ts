'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptSegmentData } from '@/types';
import { findMatches } from '@/lib/find-matches';
import type { SummaryReplaceEdit } from '@/lib/summary-find-replace';

/**
 * One hit of the find & replace panel. Matches are found inside a single
 * transcript segment or, for the summary, a single summary text block —
 * never across a boundary (the spec's boundary rule) — so `from`/`to` are
 * UTF-16 indices into that one text, exactly as `findMatches` reports them.
 */
export type FindMatchSource = 'transcript' | 'summary';

export interface Match {
    key: string;
    source: FindMatchSource;
    /** Set for transcript matches: the row to highlight and scroll to. */
    segmentId?: string;
    /** Set for summary matches: the editor block id to highlight. */
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

/**
 * One searchable unit of the summary: a single text block and its composed
 * plain text. For BlockNote (and markdown, which parses into BlockNote) the
 * text concatenates the block's inline content; for legacy it is the block's
 * plain `content`. Matches never span blocks, so `from`/`to` are indices into
 * this one text (ticket 04).
 */
export interface SummaryBlock {
    blockId: string;
    text: string;
}

/**
 * Build the summary match list: every block is scanned in order, exactly like
 * transcript segments, so the flat navigation order is «blocks top to bottom»
 * after the transcript. Cross-block matches are structurally impossible —
 * each text is one block.
 */
export function buildSummaryMatches(
    blocks: SummaryBlock[],
    query: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean },
): Match[] {
    if (!query.trim()) return [];

    const matches: Match[] = [];
    for (const block of blocks) {
        findMatches(block.text, query, options).forEach((range, index) => {
            matches.push({
                key: `summary:${block.blockId}:${index}`,
                source: 'summary',
                blockId: block.blockId,
                from: range.from,
                to: range.to,
            });
        });
    }
    return matches;
}

interface BlockNoteInlineLike {
    type?: string;
    text?: string;
    content?: unknown;
}

function inlineContentText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const node of content as BlockNoteInlineLike[]) {
        if (!node || typeof node !== 'object') continue;
        if (node.type === 'text' && typeof node.text === 'string') {
            text += node.text;
        } else if (node.type === 'link') {
            // Links wrap their own styled-text runs; their text shows in the
            // editor, so the block's searchable text includes it.
            text += inlineContentText(node.content);
        }
    }
    return text;
}

interface BlockNoteBlockLike {
    id?: string;
    content?: unknown;
    children?: unknown;
}

/**
 * Flatten BlockNote blocks (the live `editor.document`, the same shape for
 * the blocknote and markdown formats) into searchable texts: each block's
 * inline content concatenated in order, nested blocks following their parent
 * in document order. Formatting is read off, never touched — this only
 * composes the text that the find panel matches against.
 */
export function buildBlockNoteSummaryBlocks(blocks: readonly unknown[]): SummaryBlock[] {
    const result: SummaryBlock[] = [];
    const walk = (list: readonly unknown[]) => {
        for (const raw of list) {
            if (!raw || typeof raw !== 'object') continue;
            const block = raw as BlockNoteBlockLike;
            if (typeof block.id === 'string') {
                result.push({ blockId: block.id, text: inlineContentText(block.content) });
            }
            if (Array.isArray(block.children)) walk(block.children);
        }
    };
    walk(blocks);
    return result;
}

interface LegacySectionLike {
    title?: unknown;
    blocks?: unknown;
}

/**
 * Flatten the legacy summary (a map of section key → { title, blocks }) into
 * searchable texts from each block's plain `content`. Entries that are not
 * sections (`MeetingName`, `_section_order`) carry no blocks and contribute
 * nothing — only block content is searchable, per the spec.
 */
export function buildLegacySummaryBlocks(summary: unknown): SummaryBlock[] {
    if (!summary || typeof summary !== 'object') return [];

    const result: SummaryBlock[] = [];
    for (const section of Object.values(summary as Record<string, LegacySectionLike>)) {
        if (!section || typeof section !== 'object' || !Array.isArray(section.blocks)) continue;
        for (const raw of section.blocks) {
            const block = raw as { id?: unknown; content?: unknown };
            if (typeof block?.id === 'string' && typeof block.content === 'string') {
                result.push({ blockId: block.id, text: block.content });
            }
        }
    }
    return result;
}

/**
 * Thrown by {@link UseFindReplaceReturn.replaceAll} when some (but not
 * necessarily all) segment saves were rejected. Carries only the failure
 * count — the panel renders a translated toast from it, so no raw backend
 * error or meeting content can reach the UI through this error.
 */
export class ReplaceAllPartialFailureError extends Error {
    constructor(public readonly failedCount: number) {
        super(`${failedCount} segment(s) could not be saved`);
        this.name = 'ReplaceAllPartialFailureError';
    }
}

interface UseFindReplaceProps {
    /** The meeting's loaded transcript segments, in display order. */
    segments: TranscriptSegmentData[];
    /**
     * The summary's searchable blocks (ticket 04), supplied by the summary
     * surface that owns the live editor content, in display order. The
     * combined list is transcript-first, then these.
     */
    summaryBlocks?: SummaryBlock[];
    /**
     * Host action that pulls every remaining segment page into the pagination
     * state (the meeting page wires the pagination hook's `loadAllPages`).
     * Called once on the first panel open so matches cover not-yet-loaded
     * pages too.
     */
    loadAllPages?: () => void | Promise<void>;
    /**
     * The host's segment-save path — the meeting page's `onTextEdited`, which
     * is the pagination hook's optimistic `setTranscriptText` with rollback
     * (and the stale-summary hint around it). Replacement goes through exactly
     * this callback: the hook never calls the save command itself, so a row
     * edit and a replace persist identically and roll back identically.
     */
    onTextEdited?: (transcriptId: string, text: string) => void | Promise<void>;
    /**
     * The host's summary-replacement path — the summary surface applying the
     * given block/offset edits to its live editor (BlockNote: one PM
     * transaction via `applySummaryReplacements`; legacy: plain splices on
     * `block.content` through the existing change callback). Resolves false
     * when the edits were skipped — the doc text under a range no longer
     * matches the `expected` text, so the host applied nothing — exactly the
     * situation a rolled-back segment save produces on the transcript side.
     */
    onSummaryReplace?: (
        edits: SummaryReplaceEdit[],
    ) => boolean | void | Promise<boolean | void>;
}

interface UseFindReplaceReturn {
    open: boolean;
    query: string;
    /** Current contents of the «Заменить» field; '' replaces with nothing (deletion). */
    replaceText: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    /** The combined match list: transcript matches first, then summary. */
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
    setReplaceText: (value: string) => void;
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
    /**
     * Replace the active match — in a transcript segment through the host's
     * save path, or in a summary block through the host's summary-replace
     * path — and advance to the next match. Resolves when the round-trip
     * ends; a failed save (or a skipped replacement) keeps the active
     * position on the still-unreplaced match. Resolves without any host call
     * when there is no host path or no matches.
     */
    replaceActive: () => Promise<void>;
    /**
     * Replace every match in one action: one save per changed transcript
     * segment, sequenced through the host's save path, plus one summary call
     * carrying every summary edit (the host batches them into a single
     * editor transaction). A failed segment keeps its text (and, after the
     * recompute, its matches); the other segments stay saved.
     */
    replaceAll: () => Promise<void>;
    /**
     * Matches «Заменить все» can actually replace — transcript and summary
     * alike — counted in its label.
     */
    replaceableCount: number;
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
    summaryBlocks,
    loadAllPages,
    onTextEdited,
    onSummaryReplace,
}: UseFindReplaceProps): UseFindReplaceReturn {
    const [open, setOpen] = useState(false);
    const [query, setQueryState] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [focusTarget, setFocusTarget] = useState<'search' | 'replace'>('search');
    const [focusNonce, setFocusNonce] = useState(0);

    // The panel opens once per page visit and the full load is a one-shot:
    // reopening must not refetch (the rows keep their edited state in the
    // pagination hook).
    const loadAllRequestedRef = useRef(false);

    // The combined list, transcript-first then summary (the spec's navigation
    // order): one shared array, so the counter and ↑/↓ walk both sources and
    // cross their boundary cyclically.
    const matches = useMemo(
        () => {
            const options = { caseSensitive, wholeWord };
            return [
                ...buildTranscriptMatches(segments, query, options),
                ...buildSummaryMatches(summaryBlocks ?? [], query, options),
            ];
        },
        [segments, summaryBlocks, query, caseSensitive, wholeWord],
    );

    // A committed replacement asks the next recomputed match list where to
    // land: the first match strictly after the replaced range — the VS Code
    // «replace, then jump to the next» behavior. A re-match of the just
    // replaced spot is not strictly after the old range, so it never strands
    // the user on text they just typed; cycling still reaches it. The nonce
    // re-runs the effect even when the save changed no further state (the
    // optimistic update already re-rendered while the command was in flight).
    // An anchor names the replaced match's source and container (segment or
    // block), so both sides of the combined list can anchor navigation.
    const advanceAnchorRef = useRef<{
        source: FindMatchSource;
        containerId: string;
        to: number;
    } | null>(null);
    // A rejected replacement asks the opposite: land back on the match the
    // host's rollback restores, so the user faces the match they could not
    // save instead of the list head.
    const restoreAnchorRef = useRef<{
        source: FindMatchSource;
        containerId: string;
        from: number;
    } | null>(null);
    const [advanceNonce, setAdvanceNonce] = useState(0);

    // Any new match list — a new query, a toggle, or freshly loaded pages —
    // restarts navigation at the first match; with nothing found there is no
    // active position at all. A pending replacement anchor wins over that
    // reset: it says where the user should end up instead. The effect also
    // runs on the plain re-arms (the nonce bump after a save settled); those
    // must not re-reset a position an anchor just placed, so the ordinary
    // restart fires only on a genuinely new match list.
    const settledMatchesRef = useRef(matches);
    useEffect(() => {
        // A failed save asks to land back on the match the host rolled back
        // into the list (same container, same start). While the rolled-back
        // text has not arrived yet the request stays pending, so the list can
        // pass through intermediate recomputations without losing it.
        const restore = restoreAnchorRef.current;
        if (restore) {
            const landed = matches.findIndex(
                match =>
                    match.source === restore.source
                    && (restore.source === 'transcript'
                        ? match.segmentId === restore.containerId
                        : match.blockId === restore.containerId)
                    && match.from === restore.from,
            );
            if (landed >= 0) {
                restoreAnchorRef.current = null;
                advanceAnchorRef.current = null;
                settledMatchesRef.current = matches;
                setActiveIndex(landed);
                return;
            }
        }
        const anchor = advanceAnchorRef.current;
        if (anchor) {
            advanceAnchorRef.current = null;
            settledMatchesRef.current = matches;
            // Display order within a source: segments top to bottom, blocks
            // top to bottom (the same order the match list is built in).
            const orderOf = new Map<string, number>();
            segments.forEach((segment, index) => orderOf.set(`transcript:${segment.id}`, index));
            (summaryBlocks ?? []).forEach((block, index) => orderOf.set(`summary:${block.blockId}`, index));
            const sourceRank = (source: FindMatchSource) => (source === 'transcript' ? 0 : 1);
            const anchorRank = sourceRank(anchor.source);
            const anchorOrder = orderOf.get(`${anchor.source}:${anchor.containerId}`) ?? -1;
            let next = matches.findIndex(match => {
                const matchRank = sourceRank(match.source);
                if (matchRank !== anchorRank) {
                    // The combined list is transcript-first: any match of the
                    // later source is after anything in this source.
                    return matchRank > anchorRank;
                }
                const containerId = match.source === 'transcript' ? match.segmentId : match.blockId;
                if (containerId !== anchor.containerId) {
                    return (orderOf.get(`${match.source}:${containerId}`) ?? -1) > anchorOrder;
                }
                return match.from >= anchor.to;
            });
            // Nothing strictly after the replaced range: cycle to the first
            // match (VS Code wraps), or -1 when the replacement used the list
            // up entirely.
            if (next < 0 && matches.length > 0) next = 0;
            setActiveIndex(next);
            return;
        }
        if (settledMatchesRef.current !== matches) {
            settledMatchesRef.current = matches;
            setActiveIndex(matches.length > 0 ? 0 : -1);
        }
    }, [matches, segments, summaryBlocks, advanceNonce]);

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
    // display and no query, replacement text, or highlight survives the close.
    const closePanel = useCallback(() => {
        setOpen(false);
        setQueryState('');
        setReplaceText('');
        advanceAnchorRef.current = null;
        restoreAnchorRef.current = null;
        setActiveIndex(-1);
    }, []);

    // A new query is a new navigation: a pending replace/rollback anchor
    // belongs to the old list and must not steer the new one.
    const setQuery = useCallback((value: string) => {
        advanceAnchorRef.current = null;
        restoreAnchorRef.current = null;
        setQueryState(value);
    }, []);

    const goNext = useCallback(() => {
        setActiveIndex(index => (matches.length === 0 ? -1 : (index + 1) % matches.length));
    }, [matches.length]);

    const goPrev = useCallback(() => {
        setActiveIndex(index => (matches.length === 0 ? -1 : (index - 1 + matches.length) % matches.length));
    }, [matches.length]);

    // A replacement in flight: the panel's buttons use it to stay quiet while
    // the save round-trips, and a second click never fires a second write for
    // the same match.
    const replaceInFlightRef = useRef(false);

    // Splice one match range out of a segment's raw text. `from`/`to` are
    // UTF-16 indices into exactly this string (the same source `findMatches`
    // scanned), so the edit is a plain slice — `replaceText` may be '' for a
    // deletion, exactly like replacing with an empty string in an editor.
    const applyReplacement = useCallback((text: string, match: Match, replacement: string) => {
        return text.slice(0, match.from) + replacement + text.slice(match.to);
    }, []);

    // Replace the active match through the host that owns its text — the
    // segment-save path for the transcript (the same optimistic update,
    // persistence and rollback an inline row edit uses), the summary-replace
    // path for the summary (the editor applies the range inside one
    // transaction) — and only then advance. A rejected save leaves the
    // position alone: the host rolls the row back (or skipped the edit
    // because the text changed under it), the match list recomputes from the
    // actual text, and the user sees the match they could not replace still
    // in front of them.
    const replaceActive = useCallback(async () => {
        if (matches.length === 0 || replaceInFlightRef.current) return;
        const match = matches[activeIndex];
        if (!match) return;

        if (match.source === 'summary') {
            if (!onSummaryReplace || !match.blockId) return;
            const block = (summaryBlocks ?? []).find(item => item.blockId === match.blockId);
            if (!block) return;
            const expected = block.text.slice(match.from, match.to);
            if (expected === replaceText) {
                // The replacement changes nothing: no edit for a no-op — but
                // advance, so repeated «Заменить» still walks the list.
                advanceAnchorRef.current = { source: 'summary', containerId: match.blockId, to: match.to };
                setAdvanceNonce(nonce => nonce + 1);
                return;
            }
            replaceInFlightRef.current = true;
            let skipped = false;
            try {
                skipped = (await onSummaryReplace([
                    { blockId: match.blockId, from: match.from, to: match.to, expected, replacement: replaceText },
                ])) === false;
            } finally {
                replaceInFlightRef.current = false;
            }
            if (skipped) {
                // The host applied nothing (stale range): face the match that
                // is still there, like a rolled-back segment save.
                restoreAnchorRef.current = { source: 'summary', containerId: match.blockId, from: match.from };
                setAdvanceNonce(nonce => nonce + 1);
                return;
            }
            restoreAnchorRef.current = null;
            advanceAnchorRef.current = { source: 'summary', containerId: match.blockId, to: match.to };
            setAdvanceNonce(nonce => nonce + 1);
            return;
        }

        if (!onTextEdited || !match.segmentId) return;
        const segment = segments.find(item => item.id === match.segmentId);
        if (!segment) return;

        const newText = applyReplacement(segment.text, match, replaceText);
        if (newText === segment.text) {
            // The replacement changes nothing (e.g. the field repeats the
            // query): like the row editor, no save for a no-op — but advance,
            // so repeated «Заменить» still walks the list.
            advanceAnchorRef.current = { source: 'transcript', containerId: match.segmentId, to: match.to };
            setAdvanceNonce(nonce => nonce + 1);
            return;
        }

        replaceInFlightRef.current = true;
        try {
            await onTextEdited(match.segmentId, newText);
        } catch (error) {
            // The host rolled its optimistic write back; ask the recomputed
            // list to land back on this exact match (the recompute from the
            // optimistic rewrite may have moved the active position in the
            // meantime). Rethrow so the panel can toast the failure the way
            // the row editor toasts its own.
            restoreAnchorRef.current = { source: 'transcript', containerId: match.segmentId, from: match.from };
            setAdvanceNonce(nonce => nonce + 1);
            throw error;
        } finally {
            replaceInFlightRef.current = false;
        }
        // Success: any stale rollback request from an earlier failure is moot.
        restoreAnchorRef.current = null;
        advanceAnchorRef.current = { source: 'transcript', containerId: match.segmentId, to: match.to };
        setAdvanceNonce(nonce => nonce + 1);
    }, [activeIndex, applyReplacement, matches, onSummaryReplace, onTextEdited, replaceText, segments, summaryBlocks]);

    // Replace every match in one action: the plan is built once from the
    // current match list, so each changed segment gets a single save with all
    // its ranges spliced out at once, and every summary edit goes to the
    // host in ONE call it applies as a single editor transaction. Transcript
    // saves go one after another (never in parallel) because each is an
    // independent optimistic write the host can roll back on its own; a
    // rejected segment leaves its text untouched and only that segment's
    // matches survive the recompute. A summary call that the host skips
    // (stale text under a range) is not a save failure — nothing was written
    // and the survivors simply stay in the recomputed list.
    const replaceAll = useCallback(async () => {
        if (matches.length === 0 || replaceInFlightRef.current) return;

        const textById = new Map(segments.map(segment => [segment.id, segment.text]));
        const planned = new Map<string, string>();
        if (onTextEdited) {
            for (const match of matches) {
                if (match.source !== 'transcript' || !match.segmentId) continue;
                const current = planned.get(match.segmentId) ?? textById.get(match.segmentId);
                if (current === undefined) continue;
                const next = applyReplacement(current, match, replaceText);
                if (next !== current) planned.set(match.segmentId, next);
            }
        }

        const blockTextById = new Map((summaryBlocks ?? []).map(block => [block.blockId, block.text]));
        const summaryEdits: SummaryReplaceEdit[] = [];
        if (onSummaryReplace) {
            for (const match of matches) {
                if (match.source !== 'summary' || !match.blockId) continue;
                const text = blockTextById.get(match.blockId);
                if (text === undefined) continue;
                const expected = text.slice(match.from, match.to);
                if (expected === replaceText) continue; // no-op for this match
                summaryEdits.push({ blockId: match.blockId, from: match.from, to: match.to, expected, replacement: replaceText });
            }
        }

        if (planned.size === 0 && summaryEdits.length === 0) return;

        replaceInFlightRef.current = true;
        let failures = 0;
        try {
            for (const [segmentId, newText] of planned) {
                if (!onTextEdited) continue;
                try {
                    await onTextEdited(segmentId, newText);
                } catch {
                    // This host call already rolled its own row back; skip it
                    // and carry on with the rest — the failed segment's matches
                    // reappear, the saved ones disappear.
                    failures += 1;
                    continue;
                }
            }
            if (summaryEdits.length > 0) {
                // Fire-and-report: the editor applies them as one transaction;
                // a skip leaves the summary text (and its matches) as they are.
                await onSummaryReplace?.(summaryEdits);
            }
        } finally {
            replaceInFlightRef.current = false;
        }
        // No anchor here: the successful saves changed segment and block
        // texts, the match list recomputes, and the ordinary reset lands on
        // the first remaining match (the only survivors are any a failed
        // segment or a skipped block kept).
        if (failures > 0) {
            // The raw per-segment errors (possibly driver-level text) stay in
            // the hook: the count is all the panel needs for its translated
            // toast, so no private content can leak through it.
            throw new ReplaceAllPartialFailureError(failures);
        }
    }, [applyReplacement, matches, onSummaryReplace, onTextEdited, replaceText, segments, summaryBlocks]);

    const hasQuery = query.trim().length > 0;
    /**
     * Matches «Заменить все» can actually replace today, counted in its
     * label: every transcript match (saved through the segment-edit path)
     * plus every summary match the host has a replacement path for. A
     * summary match without a host path would be counted but never replaced,
     * so it stays out of the number.
     */
    const replaceableCount = matches.reduce(
        (count, match) => (match.source === 'transcript' || (match.source === 'summary' && onSummaryReplace) ? count + 1 : count),
        0,
    );

    return {
        open,
        query,
        replaceText,
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
        setQuery,
        setReplaceText,
        setCaseSensitive,
        setWholeWord,
        openPanel,
        closePanel,
        goNext,
        goPrev,
        replaceActive,
        replaceAll,
        replaceableCount,
    };
}
