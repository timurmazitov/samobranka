'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';

/**
 * Sonner replaces (never stacks) toasts that share an id, so every edit after
 * a completed summary refreshes this one hint instead of stacking copies.
 */
const HINT_TOAST_ID = 'transcript-edit-summary-hint';

interface UseTranscriptEditSummaryHintArgs {
  /** Whether the meeting already has a ready summary the edit made stale. */
  hasCompletedSummary: boolean;
  /** The existing regenerate-summary action, invoked only from the toast. */
  onRegenerate: () => void | Promise<void>;
}

/**
 * Post-edit hint for the meeting page. Summaries are built from the transcript
 * text in the database, so a saved row edit leaves an existing summary out of
 * date. The hint (a toast with a button) offers the existing regenerate action
 * when one is available; nothing regenerates automatically — that is a heavy
 * operation only the user starts.
 *
 * Returns the notify callback to call after each successful text save.
 */
export function useTranscriptEditSummaryHint({
  hasCompletedSummary,
  onRegenerate,
}: UseTranscriptEditSummaryHintArgs): () => void {
  return useCallback(() => {
    if (!hasCompletedSummary) return;
    toast.info(i18n.t('toasts.transcriptEdit.summaryOutdated'), {
      id: HINT_TOAST_ID,
      // Matches the action toasts elsewhere (recording recovery, stop).
      duration: 10000,
      action: {
        label: i18n.t('summary.regenerate'),
        onClick: () => {
          void onRegenerate();
        },
      },
    });
  }, [hasCompletedSummary, onRegenerate]);
}
