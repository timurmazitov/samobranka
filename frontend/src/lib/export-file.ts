import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { resolveMeetingDate } from '@/lib/meeting-date';

/** Longest meeting-title fragment kept in an export file name. */
const MAX_TITLE_LENGTH = 60;

/** Title used when a meeting has no usable name. */
const FALLBACK_TITLE = 'meeting';

/** Placeholder title of a not-yet-saved recording; never used as a file name. */
const NEW_CALL_TITLE = '+ New Call';

/** Characters that are illegal in file names on at least one supported OS. */
const FORBIDDEN_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** The two exports the app offers. */
export type ExportKind = 'transcript' | 'summary';

/**
 * Everything that differs between the two exports: the file name suffix, the
 * save-dialog filter and the two toasts. One descriptor per kind keeps the five
 * constants together, so no call site can pair a `md` file with a `txt` filter.
 */
export interface ExportKindDescriptor {
  /** Suffix placed before the extension, always equal to the kind. */
  suffix: ExportKind;
  /** File extension without the leading dot, e.g. `txt`. */
  extension: string;
  /** Save-dialog filter caption, e.g. `Text Files`. */
  filterLabel: string;
  /** Toast shown after a successful save. */
  successMessage: string;
  /** Toast shown when the dialog or the write fails. */
  errorMessage: string;
}

/** The single source of truth for each export kind. */
export const EXPORT_KINDS: Record<ExportKind, ExportKindDescriptor> = {
  transcript: {
    suffix: 'transcript',
    extension: 'md',
    filterLabel: 'Markdown Files',
    successMessage: 'Transcript exported',
    errorMessage: 'Failed to export transcript',
  },
  summary: {
    suffix: 'summary',
    extension: 'md',
    filterLabel: 'Markdown Files',
    successMessage: 'Summary exported',
    errorMessage: 'Failed to export summary',
  },
};

/** Toast shown when the file is saved but its path cannot be copied. */
const CLIPBOARD_FAILURE_MESSAGE = 'Saved, but could not copy the path';

export interface ExportFileNameOptions {
  /**
   * Local meeting date (GLOSSARY: «дата встречи», `recorded_at`): an RFC3339
   * string, a date-only `YYYY-MM-DD`, a `Date`, or nothing. Never `created_at`.
   */
  date?: string | Date | null;
  /** Meeting title as shown to the user. */
  title?: string | null;
  /** Which export the name is built for. */
  kind: ExportKind;
}

export interface ExportFileOptions {
  /** Text written to the file, byte for byte. */
  content: string;
  /** Name offered by the save dialog. */
  defaultFileName: string;
  /** Which export this is; selects the extension, filter and toasts. */
  kind: ExportKind;
}

/**
 * Build the default file name for an export:
 * `<YYYYMMDD>-<normalized meeting title>-<suffix>.<extension>`.
 *
 * The date is the local calendar day of the meeting; a missing or unparsable
 * date falls back to the current moment. The title keeps its script and case
 * but is made safe for file systems, and an empty title becomes `meeting`.
 */
export function buildExportFileName({
  date,
  title,
  kind,
}: ExportFileNameOptions): string {
  const { suffix, extension } = EXPORT_KINDS[kind];
  const day = resolveMeetingDate(date);
  const baseName = `${formatDateStamp(day)}-${normalizeTitle(title)}-${suffix}`;
  // The extension is appended unconditionally: `suffix` never contains a dot,
  // so no extension detection is needed and a dotted title cannot interfere.
  return `${baseName}.${normalizeExtension(extension)}`;
}

/**
 * Append `extension` to a file name the user typed without one, so the dialog
 * still offers a usable file. A name that already has an extension is returned
 * unchanged, and a bare trailing dot (`plan.`) is replaced by the extension.
 */
export function ensureFileExtension(fileName: string, extension: string): string {
  const normalizedExtension = normalizeExtension(extension);
  if (!normalizedExtension || hasFileExtension(fileName)) {
    return fileName;
  }
  return `${fileName.replace(/\.$/, '')}.${normalizedExtension}`;
}

/**
 * Save text to a file chosen in the native save dialog. The file content is
 * exactly the text passed in. After a successful save the full path is copied
 * to the clipboard and a toast names the file.
 *
 * Returns the saved path, or null when the user cancels the dialog or the save
 * fails.
 */
export async function exportFileWithDialog({
  content,
  defaultFileName,
  kind,
}: ExportFileOptions): Promise<string | null> {
  const { extension, filterLabel, successMessage, errorMessage } = EXPORT_KINDS[kind];
  const fileName = ensureFileExtension(defaultFileName, extension);

  let path: string | null;
  try {
    path = await invoke<string | null>('export_transcript_file_command', {
      content,
      defaultFileName: fileName,
      extension,
      filterLabel,
    });
  } catch (error) {
    console.error(`${errorMessage}:`, error);
    toast.error(errorMessage);
    return null;
  }

  if (!path) {
    return null;
  }

  // The file is already on disk at this point, so a clipboard problem must not
  // be reported as a failed export.
  toast.success(successMessage, { description: path });

  try {
    await navigator.clipboard.writeText(path);
  } catch (error) {
    console.error(`Failed to copy the export path to the clipboard:`, error);
    toast.warning(CLIPBOARD_FAILURE_MESSAGE, { description: path });
  }

  return path;
}

/** Meeting title normalized for a file name, never empty. */
function normalizeTitle(title?: string | null): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed || trimmed === NEW_CALL_TITLE) {
    return FALLBACK_TITLE;
  }

  const normalized = trimmed
    .replace(FORBIDDEN_FILE_NAME_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Truncate by code point so surrogate pairs are never split.
  const truncated = Array.from(normalized)
    .slice(0, MAX_TITLE_LENGTH)
    .join('')
    .replace(/_+$/g, '');

  return truncated || FALLBACK_TITLE;
}

/**
 * Whether the name already carries a file extension.
 *
 * Mirrors the spirit of Rust's `Path::extension()` in `export.rs`: something
 * must precede the last dot and a non-empty run of characters must follow it.
 * A bare trailing dot (`plan.`) and a leading-dot name (`.hidden`) are therefore
 * not extensions and get one appended — `plan.md` / `.hidden.md`, exactly like
 * Rust's `with_extension`.
 *
 * The alphabetic prefix is the one deliberate difference: a normalized title
 * can contain a dot (`20261118-Release_v1.2-summary`), and Rust would read
 * `2-summary` as the extension there and leave the name without `.md`. Only
 * user-typed trailing dot-words reach this rule, and every real extension the
 * app offers or a user is likely to type starts with a letter.
 */
function hasFileExtension(fileName: string): boolean {
  return /[^.]\.[A-Za-z][A-Za-z0-9]*$/.test(fileName);
}

/** Extension without leading dots or surrounding blanks. */
function normalizeExtension(extension: string): string {
  return extension.trim().replace(/^\.+/, '').trim();
}

/** `YYYYMMDD` for the given moment in the local time zone. */
function formatDateStamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
