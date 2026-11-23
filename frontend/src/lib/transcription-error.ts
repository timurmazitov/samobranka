import i18n from '@/i18n';

/**
 * Resolution of the coded `transcription-error` payloads (native-i18n spec
 * D7, ticket 05).
 *
 * Rust adds a stable `code` (+ `params` where a value is interpolated)
 * beside the English `userMessage` it has always emitted. The listeners
 * render `transcription.errors.<code>` through this resolver; the prose
 * field stays the fallback for an old Rust build, an absent code or a code
 * this catalog does not know yet — the never-blank contract of the
 * additive migration. The Rust registry of codes is
 * `frontend/src-tauri/src/error_codes.rs`; the pinning test
 * `tests/lib/transcription-error-i18n.test.ts` keeps the catalogs in step.
 */

/** The subset of `TranscriptionErrorPayload` the resolver reads. */
export interface TranscriptionErrorPayloadLike {
  error?: string | null;
  userMessage?: string | null;
  /** `transcription.<suffix>` — Rust `Option<&'static str>`, null when absent. */
  code?: string | null;
  /** Interpolated values for the catalog sentence (model, percent, detail). */
  params?: Record<string, unknown> | null;
}

/**
 * The diagnostic prose of a payload: the `userMessage` the Rust side keeps
 * precisely for this fallback, or the raw `error` when even that is empty —
 * a toast must never render blank (spec D7).
 */
function proseFallback(payload: TranscriptionErrorPayloadLike): string {
  const userMessage = payload.userMessage?.trim();
  if (userMessage) return payload.userMessage as string;
  return payload.error?.trim() ?? '';
}

/**
 * The localized sentence for a `transcription-error` payload.
 *
 * The catalog keys live under `transcription.errors.*`; codes carry their
 * own leading `transcription.` namespace (e.g.
 * `transcription.model_downloading`), which the key base already supplies,
 * so the resolver matches on the suffix. An unknown or absent code — and a
 * key that resolves to nothing — falls back to the payload's own prose.
 */
export function transcriptionErrorText(payload: TranscriptionErrorPayloadLike): string {
  const code = typeof payload.code === 'string' ? payload.code.trim() : '';
  if (!code) return proseFallback(payload);

  const suffix = code.startsWith('transcription.')
    ? code.slice('transcription.'.length)
    : code;
  const key = `transcription.errors.${suffix}`;
  // `defaultValue: ''` makes an unknown code resolve to the empty string
  // instead of echoing the raw key path on screen; the trim check then
  // routes every miss (and every empty value) to the prose fallback.
  const text = i18n.t(key, { ...(payload.params ?? {}), defaultValue: '' });
  return typeof text === 'string' && text.trim() ? text : proseFallback(payload);
}
