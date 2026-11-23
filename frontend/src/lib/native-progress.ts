import i18n, { type AppLanguageCode } from '@/i18n';
import { formatDecimal } from '@/lib/format-locale';

/**
 * Resolution of the coded batch-progress payloads (native-i18n spec D7).
 *
 * `import-progress` / `retranscription-progress` carry stable `code` (+
 * `params`) beside the English `message` the Rust side has always emitted.
 * The dialog renders `importAudio.progress.<code>` /
 * `retranscribe.progress.<code>` through these resolvers; a null result —
 * absent or unknown code — is the caller's cue to fall back to `message`,
 * so an old Rust build or a not-yet-translated code never renders blank
 * (the same additive contract the transcription-error chain uses).
 */

/** The coded subset of the progress payloads the resolvers read. */
export interface NativeProgressPayload {
  stage: string;
  message: string;
  code?: string;
  params?: Record<string, unknown>;
}

/**
 * Codes whose sentence already exists as a stage key; reused instead of
 * minting a duplicate (both dialogs render the stage caption beside the
 * message, and "complete" is one sentence, not two).
 */
const REUSED_KEYS: Record<'import' | 'retranscribe', Record<string, string>> = {
  import: { complete: 'importAudio.stages.complete' },
  retranscribe: { complete: 'retranscribe.stages.complete' },
};

function progressText(
  progress: NativeProgressPayload | null | undefined,
  baseKey: 'importAudio.progress' | 'retranscribe.progress',
): string | null {
  if (!progress?.code) return null;

  const key = REUSED_KEYS[baseKey === 'importAudio.progress' ? 'import' : 'retranscribe'][
    progress.code
  ] ?? `${baseKey}.${progress.code}`;

  const options: Record<string, unknown> = { ...(progress.params ?? {}) };
  // i18next selects the `_one/_few/_many/_other` family through `count`:
  // "found" counts itself, the per-segment line counts its ordinal.
  if (typeof options.found === 'number') options.count = options.found;
  else if (typeof options.current === 'number') options.count = options.current;
  // The `{:.1}s` duration follows the locale decimal separator, the same
  // rule `formatModelSize` follows (`1,2 с` in ru, `1.2s` in en).
  if (typeof options.duration_sec === 'number') {
    options.duration = formatDecimal(
      options.duration_sec,
      i18n.language as AppLanguageCode,
      1,
    );
  }

  const text = i18n.t(key, options);
  // i18next returns the key itself for a miss (returnNull is off); null lets
  // the caller apply its own `message`-prose fallback.
  return text === key ? null : text;
}

/** The localized sentence for an `import-progress` payload, or null to fall back. */
export function importProgressText(
  progress: NativeProgressPayload | null | undefined,
): string | null {
  return progressText(progress, 'importAudio.progress');
}

/** The localized sentence for a `retranscription-progress` payload, or null to fall back. */
export function retranscribeProgressText(
  progress: NativeProgressPayload | null | undefined,
): string | null {
  return progressText(progress, 'retranscribe.progress');
}

function stageLabel(stage: string, baseKey: 'importAudio.stages' | 'retranscribe.stages'): string {
  const key = `${baseKey}.${stage}`;
  const text = i18n.t(key);
  // A stage the catalogs do not know keeps its raw snake_case token: the
  // caption never goes blank, and the raw token is what makes an unforeseen
  // stage diagnosable from a screenshot.
  return text === key ? stage : text;
}

/** The bar caption for an `import-progress` stage token. */
export function importStageLabel(stage: string): string {
  return stageLabel(stage, 'importAudio.stages');
}

/** The bar caption for a `retranscription-progress` stage token. */
export function retranscribeStageLabel(stage: string): string {
  return stageLabel(stage, 'retranscribe.stages');
}
