import { toast } from 'sonner';
import i18n from '@/i18n';
import type { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';

/**
 * Persists the summary editor's unsaved edits, if any (meeting-view-toggle).
 * Both paths that leave the editor — the blur autosave and the save-guarded
 * tab switch — go through here so the dirty check and the error toast stay
 * identical. Returns true when the editor may be unmounted: nothing to save,
 * or the save succeeded. A failed save shows the error toast and returns
 * false, telling the caller to keep the editor mounted with its edits intact.
 */
export async function saveSummaryEditorIfDirty(
  editor: BlockNoteSummaryViewRef | null,
): Promise<boolean> {
  if (!editor?.isDirty) return true;
  try {
    await editor.saveSummary();
    return true;
  } catch (error) {
    toast.error(i18n.t('toasts.meetingData.changesSaveFailed'), { description: String(error) });
    return false;
  }
}
