"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import { Summary, SummaryDataResponse, SummaryFormat, BlockNoteBlock } from '@/types';
import { AISummary } from './index';
import { Block, BlockNoteEditor } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useTranslation } from 'react-i18next';
import { blocknoteDictionary } from '@/lib/blocknote-i18n';
import { blocksToMarkdownSafely } from '@/lib/blocknote-markdown';
import {
  buildBlockNoteSummaryBlocks,
  buildLegacySummaryBlocks,
  type SummaryBlock,
} from '@/lib/summary-find-blocks';
import type { Match } from '@/hooks/meeting-details/useFindReplace';
import {
  applyLegacySummaryReplacements,
  applySummaryReplacements,
  type SummaryReplaceEdit,
} from '@/lib/summary-find-replace';
import {
  applyFindHighlights,
  type SummaryFindMatch,
} from '@/lib/summary-find-reveal';
import { FindHighlightExtension } from '@/components/BlockNoteEditor/FindHighlightExtension';
import "@blocknote/shadcn/style.css";

// Dynamically import BlockNote Editor to avoid SSR issues
const Editor = dynamic(() => import('../BlockNoteEditor/Editor'), { ssr: false });

interface BlockNoteSummaryViewProps {
  summaryData: SummaryDataResponse | Summary | null;
  onSave?: (data: { markdown?: string; summary_json?: BlockNoteBlock[] }) => Promise<void>;
  onSummaryChange?: (summary: Summary) => void;
  status?: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  error?: string | null;
  onRegenerateSummary?: () => void;
  meeting?: {
    id: string;
    title: string;
    created_at: string;
    /** The meeting's own moment (RFC3339), preferred over `created_at`. */
    recorded_at?: string | null;
  };
  onDirtyChange?: (isDirty: boolean) => void;
  // Find & replace (ticket 04): the panel's match list, filtered to the
  // summary matches by the consumer; `findOpen` gates all highlighting.
  findOpen?: boolean;
  findMatches?: Match[];
  findActiveIndex?: number;
  /**
   * Reports the summary's searchable blocks (blockId + composed text, in
   * display order) whenever the editor content changes, so the page can
   * feed them into the hook's combined match list.
   */
  onSummaryBlocksChange?: (blocks: SummaryBlock[]) => void;
}

export interface BlockNoteSummaryViewRef {
  saveSummary: () => Promise<void>;
  getMarkdown: () => Promise<string>;
  isDirty: boolean;
  /**
   * Apply the find panel's summary replacements (ticket 05) to the live
   * content. Returns false — touching nothing — when a range no longer holds
   * the `expected` text (the user edited under the panel), exactly the state
   * a rolled-back transcript save produces. The change rides the editor's own
   * dirty mechanism, so the existing save persists it.
   */
  replaceSummary: (edits: SummaryReplaceEdit[]) => boolean;
}

// Format detection helper
function detectSummaryFormat(data: any): { format: SummaryFormat; data: any } {
  if (!data) {
    return { format: 'legacy', data: null };
  }

  // Priority 1: BlockNote format (has summary_json)
  if (data.summary_json && Array.isArray(data.summary_json)) {
    console.log('✅ FORMAT: BLOCKNOTE (summary_json exists)');
    return { format: 'blocknote', data };
  }

  // Priority 2: Markdown format
  if (data.markdown && typeof data.markdown === 'string') {
    console.log('✅ FORMAT: MARKDOWN (will parse to BlockNote)');
    return { format: 'markdown', data };
  }

  // Priority 3: Legacy JSON
  const hasLegacyStructure = data.MeetingName || Object.keys(data).some(key =>
    typeof data[key] === 'object' && data[key]?.title && data[key]?.blocks
  );

  if (hasLegacyStructure) {
    console.log('✅ FORMAT: LEGACY (custom JSON)');
    return { format: 'legacy', data };
  }

  return { format: 'legacy', data: null };
}

export const BlockNoteSummaryView = forwardRef<BlockNoteSummaryViewRef, BlockNoteSummaryViewProps>(({
  summaryData,
  onSave,
  onSummaryChange,
  status = 'idle',
  error = null,
  onRegenerateSummary,
  meeting,
  onDirtyChange,
  findOpen = false,
  findMatches,
  findActiveIndex = -1,
  onSummaryBlocksChange,
}, ref) => {
  const { format, data } = detectSummaryFormat(summaryData);
  const [isDirty, setIsDirty] = useState(false);
  const [currentBlocks, setCurrentBlocks] = useState<Block[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const isContentLoaded = useRef(false);

  // Create BlockNote editor for markdown parsing
  const { i18n } = useTranslation();
  // One extension instance per editor creation (language switch recreates).
  const highlightExtensionRef = useRef<FindHighlightExtension | null>(null);
  const highlightLanguageRef = useRef<string | undefined>(undefined);
  if (highlightLanguageRef.current !== i18n.language || !highlightExtensionRef.current) {
    highlightLanguageRef.current = i18n.language;
    highlightExtensionRef.current = new FindHighlightExtension();
  }
  const editor = useCreateBlockNote(
    {
      initialContent: undefined,
      dictionary: blocknoteDictionary(i18n.language),
      extensions: [highlightExtensionRef.current],
    },
    // BlockNote fixes its dictionary at creation: recreate on language switch
    // so the rendered markdown's menus and tooltips localize (native-i18n).
    [i18n.language],
  );

  // The blocknote format's live editor instance, reported by the child
  // Editor through its escape hatch (it owns the mounted instance). The
  // counter re-runs the highlight and block-report effects once an instance
  // arrives or is recreated by a language switch.
  const liveEditorRef = useRef<BlockNoteEditor | null>(null);
  const [liveEditorNonce, setLiveEditorNonce] = useState(0);
  const handleEditorReady = useCallback((live: BlockNoteEditor) => {
    liveEditorRef.current = live;
    setLiveEditorNonce(nonce => nonce + 1);
  }, []);

  // Markdown is parsed asynchronously after mount; this counter re-runs the
  // searchable-blocks report once the parse has replaced the document.
  const [contentVersion, setContentVersion] = useState(0);

  // Parse markdown to blocks when format is markdown
  useEffect(() => {
    if (format === 'markdown' && data?.markdown && editor) {
      const loadMarkdown = async () => {
        try {
          console.log('📝 Parsing markdown to BlockNote blocks...');
          const blocks = await editor.tryParseMarkdownToBlocks(data.markdown);
          editor.replaceBlocks(editor.document, blocks);
          console.log('✅ Markdown parsed successfully');

          // Delay to ensure editor has finished rendering before allowing onChange
          setTimeout(() => {
            isContentLoaded.current = true;
            setContentVersion(version => version + 1);
          }, 100);
        } catch (err) {
          console.error('❌ Failed to parse markdown:', err);
        }
      };
      loadMarkdown();
    }
  }, [format, data?.markdown, editor]);

  // Set content loaded flag for blocknote format
  useEffect(() => {
    if (format === 'blocknote' && data?.summary_json) {
      // Delay to ensure editor has finished rendering
      setTimeout(() => {
        isContentLoaded.current = true;
      }, 100);
    }
  }, [format, data?.summary_json]);

  const handleEditorChange = useCallback((blocks: Block[]) => {
    // Only set dirty flag if content has finished loading
    if (isContentLoaded.current) {
      setCurrentBlocks(blocks);
      setIsDirty(true);
    }
  }, []);

  // The searchable text per format, in display order: BlockNote and
  // markdown read the live blocks (markdown is only markdown at load — the
  // truth is the parsed BlockNote), legacy walks the section blocks' plain
  // content. Reported up so the hook folds the summary matches into the
  // combined list after the transcript's.
  const reportFindBlocks = useCallback(() => {
    if (!onSummaryBlocksChange) return;
    let blocks: SummaryBlock[];
    if (format === 'legacy') {
      blocks = buildLegacySummaryBlocks(summaryData);
    } else if (format === 'markdown') {
      blocks = buildBlockNoteSummaryBlocks(editor.document);
    } else if (liveEditorRef.current) {
      blocks = buildBlockNoteSummaryBlocks(liveEditorRef.current.document);
    } else {
      // The child Editor has not reported its instance yet: fall back to
      // the persisted JSON — the same content it mounted.
      blocks = buildBlockNoteSummaryBlocks(data?.summary_json ?? []);
    }
    const signature = JSON.stringify(blocks);
    if (signature !== lastReportedBlocksRef.current) {
      lastReportedBlocksRef.current = signature;
      onSummaryBlocksChange(blocks);
    }
  }, [onSummaryBlocksChange, format, summaryData, editor, data?.summary_json]);
  const lastReportedBlocksRef = useRef<string | null>(null);

  // Report whenever the content the summary shows can have changed: new
  // data, an editor (re)creation, the markdown parse finishing, or an edit
  // through the BlockNote onChange.
  useEffect(() => {
    reportFindBlocks();
  }, [reportFindBlocks, currentBlocks, liveEditorNonce, contentVersion]);

  // Push the panel's summary matches into the editor. BlockNote and
  // markdown highlight through the decoration plugin (all matches, the
  // active one drawn distinctly); the legacy textareas get the spec's
  // sanctioned fallback — the active match selected and scrolled into view.
  useEffect(() => {
    if (format === 'legacy') {
      if (!findOpen || findActiveIndex < 0 || !findMatches || typeof document === 'undefined') {
        return;
      }
      const active = findMatches[findActiveIndex];
      if (!active?.blockId) return;
      const textarea = document.querySelector(
        `[data-block-id="${active.blockId}"]`,
      ) as HTMLTextAreaElement | null;
      if (!textarea) return;
      // The sanctioned fallback for the textarea rows: select the match and
      // scroll it in. No focus() — the find input must keep the caret so
      // Enter/Shift+Enter keep navigating (a focused textarea would eat them).
      textarea.setSelectionRange(active.from, active.to);
      textarea.scrollIntoView({ block: 'center' });
      return;
    }

    const target = format === 'markdown' ? editor : liveEditorRef.current;
    if (!target) return;
    const summaryMatches: SummaryFindMatch[] = findOpen && findMatches
      ? findMatches.flatMap(match =>
        match.blockId ? [{ blockId: match.blockId, from: match.from, to: match.to }] : [],
      )
      : [];
    // Translate the panel's combined index to the active match's position
    // inside this summary-only list: it is the number of blockId matches
    // before it, minus none (the list is exactly the blockId matches).
    let activePosition = -1;
    if (findOpen && findMatches && findActiveIndex >= 0 && findMatches[findActiveIndex]?.blockId) {
      activePosition = findMatches
        .slice(0, findActiveIndex)
        .filter(match => match.blockId).length;
    }
    applyFindHighlights(target, summaryMatches, activePosition);
  }, [findOpen, findMatches, findActiveIndex, format, editor, liveEditorNonce]);

  // Notify parent of dirty state changes
  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // The find panel's summary replacement (ticket 05), exposed through the
  // ref. BlockNote and markdown edit the live PM doc in one transaction —
  // `editor.transact` fires the editor's onChange, which flows into
  // handleEditorChange and raises the existing dirty flag, so the ordinary
  // save persists the change; nothing here saves anything itself. The user's
  // unsaved edits are never reverted: the edits only touch their own ranges,
  // and a range whose text no longer matches `expected` aborts the whole
  // batch (return false, doc untouched) — the panel recomputes from the
  // real text, the same contract a rolled-back transcript save gives.
  // Legacy has no editor: the pure splice over the `block.content` strings
  // (same verification and atomicity) goes through the existing
  // `onSummaryChange` chain, the block-edit path's own mechanism. No dirty
  // flag is raised there on purpose — the legacy editor has never set it,
  // and saveAllChanges persists legacy content through the aiSummary branch;
  // raising the BlockNote dirty flag would misroute the save to the (empty)
  // BlockNote blocks.
  const replaceSummary = useCallback((edits: SummaryReplaceEdit[]): boolean => {
    if (edits.length === 0) return true;

    if (format === 'legacy') {
      const updated = applyLegacySummaryReplacements(summaryData as Summary | null, edits);
      if (updated === null) return false;
      onSummaryChange?.(updated);
      return true;
    }

    const target = format === 'markdown' ? editor : liveEditorRef.current;
    if (!target) return false;
    return applySummaryReplacements(target, edits);
  }, [format, summaryData, onSummaryChange, editor]);

  const handleSave = useCallback(async () => {
    if (!onSave || !isDirty) return;

    setIsSaving(true);
    try {
      console.log('💾 Saving BlockNote content...');

      // Generate markdown from current blocks; preserve BlockNote JSON even if markdown conversion fails.
      const markdownResult = await blocksToMarkdownSafely(editor, currentBlocks, {
        source: 'BlockNoteSummaryView.handleSave',
      });

      const saveData: { markdown?: string; summary_json?: BlockNoteBlock[] } = {
        summary_json: currentBlocks as unknown as BlockNoteBlock[]
      };

      if (markdownResult.markdown !== undefined) {
        saveData.markdown = markdownResult.markdown;
      }

      await onSave(saveData);
      setIsDirty(false);
      console.log('✅ Save successful');
    } catch (error) {
      console.error('❌ Save failed:', error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  }, [onSave, isDirty, currentBlocks, editor]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    saveSummary: handleSave,
    replaceSummary,
    getMarkdown: async () => {
      try {
        console.log('🔍 getMarkdown called, format:', format);
        console.log('🔍 currentBlocks length:', currentBlocks.length);
        console.log('🔍 data:', data);

        // For markdown format - use the main editor
        if (format === 'markdown' && editor) {
          console.log('📝 Using markdown editor, blocks:', editor.document.length);
          const markdownResult = await blocksToMarkdownSafely(editor, editor.document, {
            source: 'BlockNoteSummaryView.getMarkdown.markdown',
            fallbackMarkdown: data?.markdown,
          });
          console.log('📝 Generated markdown length:', markdownResult.markdown?.length || 0);
          return markdownResult.markdown || '';
        }

        // For blocknote format - use currentBlocks state
        if (format === 'blocknote') {
          console.log('📝 BlockNote format, currentBlocks:', currentBlocks.length);
          const blocks = currentBlocks.length > 0
            ? currentBlocks
            : (data?.summary_json as unknown as Block[] | undefined) || [];

          if (blocks.length > 0 && editor) {
            const markdownResult = await blocksToMarkdownSafely(editor, blocks, {
              source: 'BlockNoteSummaryView.getMarkdown.blocknote',
              fallbackMarkdown: data?.markdown,
            });
            console.log('📝 Generated markdown from blocks, length:', markdownResult.markdown?.length || 0);
            return markdownResult.markdown || '';
          }
          // Fallback: if we have the original data with markdown
          if (data?.markdown) {
            console.log('📝 Using fallback markdown from data');
            return data.markdown;
          }
        }

        // For legacy format - return empty (handled by parent)
        console.warn('⚠️ Cannot generate markdown for legacy format, returning empty');
        return '';
      } catch (err) {
        console.error('❌ Failed to generate markdown:', err);
        return '';
      }
    },
    isDirty
  }), [handleSave, replaceSummary, isDirty, editor, format, currentBlocks, data]);

  // Render legacy format
  if (format === 'legacy') {
    console.log('🎨 Rendering LEGACY format');
    return (
      <AISummary
        summary={summaryData as Summary}
        status={status}
        error={error}
        onSummaryChange={onSummaryChange || (() => { })}
        onRegenerateSummary={onRegenerateSummary || (() => { })}
        meeting={meeting}
      />
    );
  }

  // Render BlockNote format (has summary_json)
  if (format === 'blocknote') {
    console.log('🎨 Rendering BLOCKNOTE format (direct)');
    return (
      <div className="flex flex-col w-full">
        <div className="w-full">
          <Editor
            initialContent={data.summary_json}
            onChange={(blocks) => {
              console.log('📝 Editor blocks changed:', blocks.length);
              handleEditorChange(blocks);
            }}
            onEditorReady={handleEditorReady}
            editable={true}
          />
        </div>
      </div>
    );
  }

  // Render Markdown format (parse and display in BlockNote)
  if (format === 'markdown') {
    console.log('🎨 Rendering MARKDOWN format (parsed to BlockNote)');
    return (
      <div className="flex flex-col w-full">
        <div className="w-full">
          <BlockNoteView
            editor={editor}
            editable={true}
            onChange={() => {
              if (isContentLoaded.current) {
                handleEditorChange(editor.document);
              }
            }}
            theme="light"
          />
        </div>
      </div>
    );
  }

  return null;
});

BlockNoteSummaryView.displayName = 'BlockNoteSummaryView';
