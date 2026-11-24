# 01: Одиночное удаление речевого сегмента (трассер)

**What to build:** В карточке завершённой встречи при наведении на строку транскрипта появляется иконка корзины; клик по ней мгновенно удаляет речевой сегмент — он исчезает из просмотра и из базы, панель спикеров обновляется (если это был последний сегмент спикера, он уходит вместе с назначениями имени), появляется подсказка «саммари устарело / Regenerate». Ошибка удаления не показывает содержимое транскрипта, а сегменты откатываются на место. Удаление недоступно во время записи, диаризации и ретранскрипции. Это полный трассер: через него проходит и батч-команда удаления, которой впоследствии пользуется массовое удаление.

**Blocked by:** None (can start immediately).

**Status:** claimed

- [x] Новая батч-команда удаления сегментов встречи: одна транзакция — проверка принадлежности id встрече, удаление, обновление времени правки встречи, однократный reconcile назначений спикеров (уход меток без сегментов и сирот справочника людей, уважать names-reset событие); unknown/чужой id — ошибка без содержимого встреч в `Display`, частичного удаления нет.
- [x] Тесты репозитория на in-memory SQLite с настоящими миграциями: свои id удаляются; чужая встреча/несуществующий id — отказ; атомарность; bump времени правки; reconcile скрывает спикера без сегментов и не трогает остальных.
- [x] Метод удаления в хуке пагинации сегментов: оптимистичное удаление из локального списка, декремент `totalCount`, откат при ошибке.
- [x] Тесты хука: оптимистичное удаление и откат при reject, честность `totalCount`/`has_more`.
- [x] Hover-иконка корзины в строке виртуализированного представления транскрипта (рядом с карандашом редактирования); одиночное удаление применяется сразу, без подтверждения.
- [x] Гейты: недоступно при записи, диаризации, ретранскрипции (совпадают с гейтами редактирования плюс ретранскрипция).
- [x] После удаления работают: копирование/экспорт/поиск без удалённого сегмента, пустой транскрипт после удаления всех сегментов — валидное состояние.
- [x] UI-тексты — по GLOSSARY.md («речевой сегмент», не «реплика»).

## Comments

Реализация (трассер тикета 01):

- **Репозиторий** (`database/repositories/transcript.rs`): `TranscriptsRepository::delete_batch(pool, meeting_id, ids) -> Result<ReconcileOutcome, TranscriptError>` — одна транзакция: meeting-exists check, проверка принадлежности всех id встрече одним `SELECT ... IN (...)` (плейсхолдеры собираются вручную, дедупликация id), `DELETE`, bump `meetings.updated_at` (`Utc::now().naive_utc()`), однократный `reconcile_meeting_speaker_assignments` внутри той же транзакции. Пустой батч — `Ok` без обращения к БД (валидного `IN ()` в SQLite нет). Новый вариант `TranscriptError::MeetingNotFound`; `Display` несёт только id. 13 Rust-тестов (in-memory SQLite, `migrated_pool()`).
- **Команда** (`api/api.rs`): `api_delete_transcripts(app, state, meeting_id, ids)`, зарегистрирована в `lib.rs`. `speaker-names-reset` эмитится **после** commit при `outcome.names_reset` — паттерн retranscription/diarization (константы из `audio::transcription::diarization_service`).
- **Хук** (`hooks/usePaginatedTranscripts.ts`): `deleteTranscripts(ids: string[])` — оптимистичное удаление из `transcriptsRef`, декремент `totalCount`/`offsetRef`, честный `hasMore` (`loadedCount === totalCount ⇒ false`), откат с сортировкой по `audio_start_time` при reject, ре-throw для тоста строки. Все setState под `isCurrentRequest` (изоляция смены встречи). Публичный API принят списком id с самого начала — тикет 02 строится без редизайна (после bulk — свой refetch страницы).
- **Строка** (`VirtualizedTranscriptView.tsx`): hover-корзина (lucide `Trash2`) следующим соседом карандаша в `group`-диве, мгновенное удаление без подтверждения; гейт `allowDelete = !isRecording && !isDiarizing && !isRetranscribing` проброшен в **обе** ветви рендера. При ошибке — тост только из переводных строк, сырая ошибка в `console.error` (приватность как у текстового редактирования).
- **Гейт ретранскрипции**: флага во фронтенде не было — добавлен `hooks/useRetranscriptionRunning.ts` (injectable listen/invoke seams): сид через `is_retranscription_in_progress_command`, затем `retranscription-progress` (открытие, scoped по meeting_id) / `-complete` / `-error` (закрытие глобально — флаг в нативке один на приложение). Сбой сида не закрывает гейт (правило failed-pass).
- **Панель спикеров**: после успешного удаления `page.tsx` вызывает `loadMeetingSpeakers()` (read DB — reconcile в команде уже убрал мёртвые назначения). Names-reset listener покрывает случай «исчезли все имена».
- **Подсказка «саммари устарело»**: одиночное удаление идёт через `notifySummaryStale()` в `page-content.tsx` — та же цепочка колбэков, что у текстовых правок (тикеты 02/05 переиспользуют её для bulk, id-дедупликация sonner).
- **Производные поверхности** (копирование/экспорт/поиск/вход саммари): читают БД — отдельной логики нет (проверено: `useCopyOperations` перечитывает страницы через `api_get_meeting_transcripts`).
- **Каталоги**: ключи `transcript.deleteSegmentTooltip/deleteSegmentFailed/deleteSegmentFailedDescription` в en+ru («речевой сегмент», без «реплика»); i18n-parity и i18n-usage зелёные.
- **Тесты**: `cargo test -p samobranka --lib database::repositories::` 95 pass; `cargo test -p samobranka --lib` 808 pass; bun пофайлово (документированная методика, полный `bun test` в этом окружении загрязнён cross-file `mock.module`): `paginated-transcripts` 21, `transcript-row-delete` 7, `retranscription-running` 8, `transcript-text-edit` 17, `meeting-details-summary-hint` 8, `i18n-parity` 5, `i18n-usage` 11 — все зелёные.

Решения для тикетов 02–05: `deleteTranscripts(ids)` уже батч; после bulk делать refetch текущей страницы (хук `refetch()` перезагружает только page 0 — при необходимости добавить перезагрузку окна от `offsetRef`); `notifySummaryStale` вызывать один раз после bulk-удаления; кнопка «Выделение» в `TranscriptButtonGroup` должна получать `isRecording`/`isDiarizing`/`isRetranscribing` пропсами (сейчас группа их не получает — TranscriptPanel их не пробрасывает).
