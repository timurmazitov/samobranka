# 05: Подсказка «саммари устарело» после массового удаления

**What to build:** После массового удаления сегментов (тикет 02) пользователь получает ту же подсказку «саммари устарело / Regenerate», которую транскрипт уже показывает после правки текста и после одиночного удаления (тикет 01). Уже сгенерированное саммари остаётся доступным и не пересобирается автоматически; Regenerate строит саммари только по оставшимся сегментам. Реализация — переиспользование существующего хука подсказки об устаревании саммари, а не новая логика.

**Blocked by:** 02 (Режим выделения с массовым удалением).

**Status:** resolved

- [x] После успешного массового удаления (N>1) появляется тост-подсказка об устаревании саммари с действием Regenerate.
- [x] Подсказка не появляется, если у встречи нет сгенерированного саммари (поведение как при правке текста).
- [x] Regenerate после удаления использует входной текст только из оставшихся сегментов.
- [x] Тест(ы) на срабатывание подсказки по событию массового удаления — по образцу существующих тестов хука подсказки.

## Comments

Реализация (тикет 05) — только переиспользование, новой логики подсказки нет:

- **Провязка** (`app/meeting-details/page-content.tsx`): `handleSegmentsBulkDeleted` вызывает `notifySummaryStale()` ровно один раз **после** успешного `onSegmentsBulkDeleted` — тот же хук `useTranscriptEditSummaryHint` и та же id-дедуплицированная sonner-цепочка (`id: 'transcript-edit-summary-hint'`), что у текстовых правок и одиночного удаления (тикет 01). Отказ батча уходит в `throw` тулбару (его приватный тост) и подсказку не показывает — подсказка идёт после `setSelectedSegments([])`, поэтому очистка выделения от успеха не зависит. Авто-пересборки нет: `Regenerate` по-прежнему запускает только существующий `summaryGeneration.handleRegenerateSummary`.
- **Regenerate по оставшимся сегментам** — отдельной кодовой правки не потребовалось, поведение проверено тестом: вход саммари собирается в `useSummaryGeneration.fetchAllTranscripts` из `api_get_meeting_transcripts` (читает `transcripts` в БД, куда батч-команда тикета 01 уже сделала `DELETE`), а не из клиентского списка пагинации. Новый тест `regeneration sends only the transcript rows still in the database` (`tests/hooks/summary-generation.test.tsx`) даёт репозиторию-стабу одну выжившую строку после удаления и проверяет, что в `api_process_transcript` уходит текст только этой строки (`isRegeneration` путь `handleRegenerateSummary`). Истина уровня репозитория («удаляются именно эти id») покрыта Rust-тестами тикета 01 (`delete_batch`, 13 тестов) — здесь не дублируется.
- **Тесты** (`tests/components/meeting-details-summary-hint.test.tsx`, по образцу существующих тестов хука подсказки в этом файле — тот же page-level seam с захваченными пропами `TranscriptPanel` и моком sonner): `a bulk delete while a completed summary exists offers regeneration once` (один тост на батч N=2, точная строка `toasts.transcriptEdit.summaryOutdated`, `id` и лейбл `Regenerate Summary`, клик по действию → один `handleRegenerateSummary`); `a bulk delete with no summary shows no hint` (`summaryStatus` ≠ completed → тишина); `a rejected bulk delete shows no hint and keeps propagating to the toolbar` (ошибка батча не проглатывается, подсказки нет).
- **Проверки** (`bun test` пофайлово, методика docs/RUNNING_LINUX.md §9; в worktree `node_modules` — симлинк на основной checkout): `meeting-details-summary-hint` 16 pass (было 13), `summary-generation` 17 pass (было 16), `transcript-edit-summary-hint` 3, `transcript-selection` 6, `transcript-selection-mode` 11, `transcript-selection-button` 4, `paginated-transcripts` 25, `i18n-parity` 5, `i18n-usage` 11 — все зелёные. `tsc --noEmit` чище только на документированную pre-existing ошибку `tests/lib/stage-transcribe-native.test.ts(40,14)` TS7053. Rust не трогался.
- **Не проверялось вживую**: реальный Tauri-прогон (нужны боковая сборка и устройства) — массовое удаление с таостом и нажатие Regenerate в GUI. Поведение подтверждено на page-level seam.
