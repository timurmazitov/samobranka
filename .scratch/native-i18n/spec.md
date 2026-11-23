# Native (Rust) interface localization — Russian

Status: ready-for-agent

## Problem

The frontend interface is fully internationalized (`i18next` + `react-i18next`,
`frontend/src/i18n/`, ~812 keys in each of `en` and `ru`, guarded by
`frontend/tests/lib/i18n-parity.test.ts` and `i18n-usage.test.ts`). Text that
originates in Rust is English-only: `frontend/src-tauri` has no i18n crates, no
`locales/`, no locale lookup. `frontend/src/lib/app-language.ts:6-9` already
persists the UI language into `preferences.json` in the app config directory
*specifically* so that Rust could read it later — but nothing on the Rust side
reads `app_language` today.

The user reported three English surfaces:

1. the tray menu;
2. model details in the transcription model-picker settings window;
3. the transcription progress window.

Investigation shows these three are not one kind of problem, and lumping them
into "translate Rust" produces a second string catalog that drifts from the
frontend one. This spec splits them by *who must own the string*.

## Goal

Russian text in the three reported surfaces, switching live from the existing
language picker, with exactly one source of truth per string.

## Governing rule

**A string is localized in Rust only if a Rust-side addressee renders it** — an
OS tray menu, a native dialog, a system notification. **A string that travels to
the frontend as data is localized by the frontend**: Rust sends a stable code
plus parameters, the frontend resolves it through `t()`.

Rationale: the frontend already has the catalogs, the plural categories, the
parity guards and the language switcher. A Rust catalog of prose that only React
renders is a duplicated source of truth that nothing keeps in sync.

Applying the rule to the three surfaces:

| Surface | Owner | Why |
| --- | --- | --- |
| Tray menu, tooltip | **Rust** | OS-drawn menu; React never sees it |
| Model card `description` | **Frontend** | travels as data; sibling field `taskLabel()` already does exactly this |
| Progress / error prose (`transcription-error`, import, retranscribe, diarization) | **Frontend**, Rust emits codes | rendered into toasts and dialogs by React |
| Dead Rust progress strings | **Deleted** | no frontend listener exists |

## Decisions

### 1. Infrastructure lives in one module

`frontend/src-tauri/src/l10n/` — one loader plus one typed struct per surface
(`TrayStrings`, later `NotificationStrings`). Modelled on Handy's
`src-tauri/src/tray_i18n.rs`, where `TrayStrings` is one struct per surface.

Not per-site ad-hoc maps: the loader and the fallback chain get written once, and
a typed struct makes a missing field a compile error rather than a silently
English menu item.

### 2. Catalogs are Rust-owned JSON, resolved at runtime

`frontend/src-tauri/locales/en.json` and `ru.json`. English is the fallback and
the source of truth for key existence. Lookup by string key into typed structs.

**Not** Handy's `build.rs` codegen from the frontend's `locales/*/translation.json`.
Handy can do that because its `src/i18n` and `src-tauri` always build together;
here it would couple `cargo build` to the frontend tree, adding a failure mode
for Rust-only builds and CI. Type safety comes instead from a unit test
(D11) — which is the same discipline `i18n-parity.test.ts` already enforces on
the frontend, so this is the repo's idiom, not a substitute for codegen.

### 3. Language resolution at startup

In `setup()`, before the tray is built (`lib.rs:582` calls
`tray::create_tray`), read `app_language` from `preferences.json` via
`tauri_plugin_store::StoreExt` — the precedent is `audio/recording_preferences.rs:290`
(`app.store("recording_preferences.json")`).

**Fallback when the key is absent** (first run — `loadAppLanguage()` returns
`null` and no value is ever written until the user touches the picker) must
reproduce the frontend algorithm, not reinvent it: primary subtag of the OS
locale, `ru` → Russian, anything else → English. Compare
`frontend/src/i18n/index.ts:49-53` (`normalizeAppLanguage`).
`@tauri-apps/plugin-os` has no Rust half installed in this workspace, so use
`tauri::Manager`'s locale facility or a `sys-locale` dependency — decide during
implementation, preferring no new dependency.

Normalization must handle `ru-RU`, `ru_RU`, case: `ru-RU` → `ru`, unknown tag → `en`.

### 4. Live switching, no restart

`LanguageContext.setLanguage()` (`frontend/src/contexts/LanguageContext.tsx:77-89`)
already does `i18n.changeLanguage` → `saveAppLanguage` → `<html lang>` → window
title in one place. Add one `emit("app-language-changed", language)` there. Rust
listens and rebuilds the tray.

No restart prompt, and no new command: the tray is *already* rebuilt on every
recording state change (`tray.rs:298-317` → `tray.set_menu(Some(menu))`), so
re-localizing means `build_menu` reads the current language at call time. The
two other surfaces are React and re-render on their own.

Keep the current language in shared app state (`app.manage`), not in a
`Lazy`/`OnceCell` — `tray.rs` caches nothing today and must not start.

### 5. Emojis move out of the literals

Current labels bake emojis into the English text: `"⏸ Pause Recording"`
(`tray.rs:350`), `"⏹ Stop Recording"` (`:351`), `"▶ Resume Recording"` (`:365`),
`"🔄 Starting Recording..."` (`:343`), `"⏳ Downloading transcription model..."` (`:331`).

Catalog values become `"Pause Recording"` / `"Пауза записи"` and Rust prepends
the glyph. Emojis stay for now — they encode recording state, and removing them
is an unrelated UX decision. Separating them makes that decision one-line later
and keeps translators from copying glyphs.

### 6. Model card prose belongs to the frontend catalog

`display_name` and `description` are Rust `&'static str` in fully static
catalogs — `transcribe_cpp_engine/catalog.rs:178-269` and
`audio_cpp_engine/catalog.rs:136-152`. Nothing is fetched: `source_url` is a
pinned HuggingFace URL that is *not* shipped to the frontend and never queried
for metadata.

**Localize `description` in the frontend catalog**, resolved by `family`, following
the existing precedent: the card ignores the Rust-authored `ModelTask::label()`
(`audio_cpp_engine/catalog.rs:43-46`) and uses `taskLabel()` from
`frontend/src/lib/audiocpp.ts:105` → `i18n.t('models.audioCpp.taskDiarization')`.

- Keys: `models.transcribeCpp.descriptions.<family>`,
  `models.audioCpp.descriptions.<family>`.
- **`display_name` is not translated** — `GigaAM v3 CTC`, `Whisper large-v3 Turbo`,
  `Parakeet Ultra`, `Nemotron-3 Diarization` are proper names, and
  `.scratch/i18n/spec.md` already rules model and engine names stay in Latin
  script. `family` and `quantization` (`Q8_0`, `BF16`) are technical tokens: leave
  verbatim, as the card renders them today.
- The macro currently appends English prose at compile time:
  `transcribe_cpp_engine/catalog.rs:154`
  `concat!($description, " Quantization: ", stringify!($quant), ".")`. With the
  description moving to the frontend, that sentence moves out too and becomes a
  frontend key next to the already-localized `quantization` badge.
- **Consequence to guard**: adding a model to the Rust catalog must come with its
  description keys, or the card renders an empty description. Add a test that
  every `family` in both Rust catalogs has description keys in both locales.

Rejected alternative: `display_name_ru` / `description_ru` on `ModelSpec`/`ModelInfo`
and a field pick in the card. It doubles the prose inside the `model_catalog!`
macro (`catalog.rs:133-170`), fights the `concat!` suffix, forces edits to the
catalog tests (`catalog.rs:281-580`), and creates a second description catalog
beside an existing complete one.

### 7. Rust sends codes; prose stays as fallback

For every event payload that renders Rust prose verbatim, **add** `code` (+
`params` where interpolated) and **keep** the existing English field as the
diagnostic fallback. Do not strip prose.

Why additive: `userMessage` and `error` reach logs and user screenshots, and a
`t(code)`-only frontend renders an empty toast for any code it does not know yet.
Additive migration also leaves existing listeners (`hooks/useModalState.ts:134-147`,
`components/RecordingControls.tsx:278`) untouched, so each string family can be
migrated on its own instead of one breaking sweep.

Codes are stable identifiers (`transcription.model_not_downloaded`), not the
English text. Technical tails from native libraries stay untranslated in
`params.detail` and are displayed as-is: their producers are not ours to control,
and the raw tail is what makes bug reports diagnosable. The human-readable half
is what the user actually reads.

### 8. Diarization constants collapse to one source

`diarization_service.rs:30-56` defines `DIARIZATION_UNAVAILABLE_MESSAGE`,
`DIARIZATION_RUNTIME_UNAVAILABLE_MESSAGE`, `DIARIZATION_FAILED_MESSAGE`,
`DIARIZATION_DEFERRED_MESSAGE`, `SPEAKER_NAMES_RESET_MESSAGE`. These are mirrored
verbatim in `frontend/src/lib/diarization.ts:88-121` and pinned by
`frontend/tests/lib/live-diarization.test.ts` — two identical English texts that
must match.

**Frontend becomes the single source**: Rust emits a state code
(`unavailable` | `runtime_unavailable` | `failed` | `deferred` | `reset`), the TS
mirrors become i18n keys, and the pinning test becomes a key-resolution test.
This is the duplicated source of truth rule 1 exists to prevent, already present
in the codebase.

### 9. Delete dead strings instead of translating them

Rust emits `message` fields no frontend listener reads; translating them wastes
the work and leaves catalog keys nobody will ever update:

- `recording-shutdown-progress` — the listener reads only `payload.stage`
  (`RecordingStateContext.tsx:167-174`). Rust strings at
  `audio/recording_commands.rs:1000, 1048, 1076, 1116, 1190, 1255, 1264` never
  reach the screen.
- `transcription-progress` (`audio/transcription/worker.rs:333`),
  `transcription-queue-complete` (`worker.rs:359`),
  `transcript-chunk-loss-detected` (`worker.rs:389`) — no listener at all.
- `transcription-warning` (`audio/transcription/engine.rs:377`,
  `transcribe_cpp_engine/transcription.rs:224` Vulkan-fallback notice) — no
  listener; *revisit* rather than delete if surfacing that warning is wanted,
  since it is genuinely useful to users.

If such a string is ever needed again it returns as a frontend key, not as Rust
prose. Deleting is a separate ticket from translating so a regression is
attributable.

### 10. Russian plural categories with a small local helper

English `"{} of {}"` and `"{} found"` need nothing; Russian needs CLDR
`one/few/many/other` («1 минута», «2 минуты», «5 минут»). Handy does not solve
this at all (its second language is Chinese).

**Write a ~30-line category helper in `l10n/` using the same suffixes i18next
uses** — `_one`/`_few`/`_many`/`_other` — and no new crate. The suffixes already
match the frontend: `ru/translation.json` carries 26 such keys
(`retranscribe.completeToast_few`, `models.builtIn.tokens_many`, …), so Rust and
the frontend speak one format and the parity test stays trivial. A
`fluent`/`rust-i18n` dependency would introduce a MessageFormat dialect
incompatible with the frontend files, to buy one function.

Where a number can be dropped from the wording without losing meaning, drop it —
that is cheaper than any plural machinery.

Plural-sensitive strings in scope: `audio/import.rs:442`
`"Detecting speech segments... {}% ({} found)"`, `audio/import.rs:589` and
`audio/retranscription.rs:385` `"Transcribing segment {} of {} ({:.1}s)..."`,
`audio/retranscription.rs:249`.

### 11. Verification

- **Rust unit tests** in `l10n/`: key-set parity across `en.json` and `ru.json`
  and coverage of every struct field; fallback chain `ru-RU` → `ru`, unknown tag
  → `en`, `ru_RU` and casing variants — modelled on the `tray_i18n.rs`
  `resolves_locale_fallbacks` table test in Handy.
- **Tray: manual run in `pnpm run tauri:dev`**, per `AGENTS.md` (a bare Next.js
  server does not exercise native code). Verify all seven menu states —
  stopped / starting / recording / pausing / paused / resuming / stopping — plus
  the disabled `Downloading transcription model...` state, in *both* languages,
  switching live from Settings → General without restart. Include a Linux
  desktop: emoji glyph rendering differs across desktop environments and is the
  likeliest visual regression here.
- **Default-language scenario must be tested explicitly**: `preferences.json`
  with no `app_language` key at all. This is the first-run case and the one where
  Rust and the frontend can silently disagree.
- **Frontend block**: existing `i18n-parity` and `i18n-usage` tests.
- Report what actually ran, observed results, platform, and what stayed untested
  (`AGENTS.md` — never invent build or hardware results).

## Vocabulary

Follows `GLOSSARY.md` and the table in `.scratch/i18n/spec.md`: Recording →
Запись, Transcription → Транскрибация, Transcript → Транскрипция, Speaker →
Спикер, Settings → Настройки. Register: neutral, impersonal, no «вы»/«ты»,
sentence case, buttons in perfective imperative («Начать запись»), errors
impersonal («Не удалось загрузить модель»).

Latin script stays: `Samobranka`, model and engine names, `Vulkan`, `CPU`, `GPU`,
`GGUF`, `GGML`, `SHA-256`, format tokens, `API`. Quantization tokens (`Q8_0`,
`BF16`) are not translated.

Tray labels therefore read «Начать запись», «Пауза записи», «Продолжить запись»,
«Остановить запись», «Открыть главное окно», «Настройки», «Проверить обновления»,
«Выйти».

## Out of scope (next phase)

Infrastructure built here covers these almost for free; they are listed so the
candidates are not lost. Not implemented by this spec:

- **System notifications** — `notifications/types.rs:134-209`:
  `"Recording has been paused"`, `"Recording has been resumed"`,
  `"Meeting '{}' starts in {} minutes"`, `"Transcription completed and saved to: {}"`,
  title `"Samobranka Error"`. OS-drawn ⇒ Rust-owned, so they take the `l10n/`
  catalog directly. Needs a `NotificationStrings` struct. Note `"…starts in {}
  minutes"` is plural-sensitive.
- **`linux-audio-notice` messages** — `recording_commands.rs:606, 854, 1029, 1721,
  1728, 1955, 1959, 2119, 2125`, plus the `"Microphone"` / `"System audio"` role
  words at `:1951, 1953, 2112, 2114`. Rendered verbatim as toasts
  (`RecordingStateContext.tsx:250-251`) ⇒ frontend-owned, codes per D7. Consistent
  with `AGENTS.md`'s "microphone"/"system" naming rule.
- **`AudioError::user_message()` set** — `recording_state.rs:74-89`
  (`"Microphone permission denied"`, `"Audio device was disconnected"`, …) ⇒ codes.
- **Model download/verification errors** — `model_downloader.rs:21, 53, 73, 117`,
  `transcribe_cpp_engine/models.rs:84, 110`, `audio_cpp_engine/models.rs:63, 130`,
  `commands.rs:282, 337` ⇒ codes, with the raw cause in `params.detail`.
- **Native dialog filter captions** — `export.rs:17` `"Text Files"`,
  `database/commands.rs:33` `"Database Files"`, `audio/import.rs:899`
  `"Audio Files"`. The frontend passes its own `"Markdown Files"`
  (`lib/export-file.ts:43,50`), so these are mixed-owner.
- **Summary model picker** — `summary/summary_engine/models.rs:169, 177, 183, 190,
  195, 203, 208, 216`: `"Qwen 3.5 2B (Balanced)"`, tier names in parentheses,
  descriptions. Same `display_name`/`description` category as D6, different window
  (`ModelSettingsModal.tsx`). Tier words ("Balanced", "Fast", "High Quality") are
  prose and *should* be translated, unlike model names.
- **Summary `error` field** — `summary/processor.rs:453, 514`,
  `summary/llm_client.rs:415, 431, 496`.
- **Ollama errors** — `ollama/ollama.rs:300-394`.
- **`api/api.rs` and `summary/commands.rs` `message` fields** — `"…saved
  successfully"` set, currently only `console.log`-ed. Safe now; must be coded
  *before* anyone renders them.
- **`import-warning`** (`audio/import.rs:501-509`) — no frontend listener found,
  so it may be dead code rather than an unlocalized surface. Triage before
  translating.

## Tickets

- `issues/01-l10n-module.md` — catalog loader, structs, plural helper, tests, no call sites.
- `issues/02-app-language-bridge.md` — read `preferences.json` in `setup()`, emit/listen `app-language-changed`.
- `issues/03-tray.md` — `TrayStrings`, `build_menu`, emoji separation, manual matrix in `tauri:dev`.
- `issues/04-model-descriptions.md` — frontend keys per `family`, drop `concat!` quantization suffix, catalog↔catalog test.
- `issues/05-error-codes.md` — additive `code`+`params` on `transcription-error`, model-not-ready, provider errors; frontend resolution.
- `issues/06-import-retranscribe-progress.md` — codes for the rendered progress strings, plural helper consumers.
- `issues/07-diarization-single-source.md` — state codes, remove `lib/diarization.ts` mirrors, repoint the pinning test.
- `issues/08-delete-dead-strings.md` — remove unread `message` fields, decide the `transcription-warning` case.
- `issues/09-frontend-literals-bypass.md` — English literals in the frontend, plus fix the `i18n-usage` guard that missed them.

## Comments

- 2026-11-23: Spec written from a grilling session. Supersedes the outline in
  `.scratch/i18n/issues/01-native-strings.md`, whose file references predate the
  removal of the legacy audio.cpp transcription backend
  (`audio_cpp_engine/transcription.rs`, `session_thread.rs` no longer exist).
- 2026-11-23 (review fix): **Judgement items evaluated, left as-is.**
  (a) *7-arg `emit_progress` data clump* (retranscription.rs's
  `app/meeting_id/stage/progress/message/code/params`): collapsing it into a
  payload struct would touch all 22 emit sites in the two batch files for a
  cosmetic gain and a wire-shape risk on exactly the events the frontend
  pinning tests guard; the shared half (message/code/params builders) is
  already one source in `audio/progress_codes.rs`. Not worth the churn.
  (b) *`Plural::Other` `#[allow(dead_code)]`*: integer counts never select
  `Other`, but `PluralForms::select` must match on it and the field is the
  documented last-resort fallback for fractional counts; removing the variant
  would force an unreachable arm or drop the catalog's `_other` key from the
  contract. The allow is honest and documented (l10n/mod.rs).
  (c) *`stored_language_value` wrapper*: it exists so the startup log can
  distinguish "no key" from "bad value" (`stored={stored:?}`) while
  `resolve_language` applies the exact-code gate itself, and it is
  directly unit-tested; inlining the one-line `as_str()` map would lose the
  log distinction for no gain.
- 2026-11-23 (review fix): the branch's commit-message style (ticket-scoped
  Russian subjects, `native-i18n: тикет NN — …`) follows repo precedent and
  was accepted in review; the branch squashes at merge per CONTRIBUTING's
  review process.
- 2026-11-23 (review fix): **D10 Rust-side plural consumption was resolved
  frontend-side** per the governing rule: the plural-sensitive progress
  strings (segments found, `segment N of M`) travel as codes with `params`
  and the `_one/_few/_many/_other` families are selected by i18next through
  `count` in `frontend/src/lib/native-progress.ts` (ticket 06); the Rust
  `Plural`/`PluralForms` helper has no non-test consumer today (no tray
  string is plural-sensitive) — it is the built-ahead facility for the
  OS-drawn out-of-scope surfaces that are (the "starts in {} minutes"
  notification). No Rust code imports it for progress, which is the intended
  division, not drift.
