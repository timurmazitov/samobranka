# Исследование: редактирование текста транскрипции (правка ошибок распознавания)

Дата: 2026-11-24. Исследование только для чтения — код не изменён. План реализации,
без правок. Ответ на вопрос: «как реализовать редактирование исходного текста
транскрипции с помощью уже используемых в проекте веб-компонентов».

Все утверждения даны с путями к файлам (где полезно — со строками). Версии
библиотек взяты из `frontend/package.json`.

---

## Контекст и цель

После записи встречи пользователь хочет исправить ошибки распознавания в исходном
тексте транскрипции и сохранить исправления. Сейчас транскрипт только отображается,
копируется и экспортируется; текста править нельзя. Существующая точка «правки одной
строки» уже есть, но только для **спикера** строки, не для текста
(`VirtualizedTranscriptView.tsx:141-157`, `api_set_transcript_speaker`).

Проект: Next.js/React UI поверх Rust/Tauri-ядра. Frontend вызывает Tauri-команды,
Rust шлёт события (`AGENTS.md`, «Project Overview»). Транскрипт хранится в SQLite,
саммари генерируется из хранимого текста транскрипта.

Важное следствие, которое план обязан учесть: **саммари строится из текста, читаемого
из БД** (`lib/summary-transcript-payload.ts:26`, `hooks/meeting-details/useSummaryGeneration.ts:347-378`,
`431`, `455`). Поэтому правка текста после генерации саммари не меняет уже созданный
саммари сам по себе — чтобы он стал соответствовать исправленному тексту, саммари нужно
пересоздать (`handleRegenerateSummary`, `useSummaryGeneration.ts:440-455`).

---

## Как транскрипция устроена сейчас (поток данных)

### 1. Живой транскрипт во время записи

- Rust-worker транскрипции шлёт событие `transcript-update` с сегментом
  (`audio/transcription/worker.rs:290`, `app_clone.emit("transcript-update", &update)`).
- Frontend слушает его в `TranscriptService.onTranscriptUpdate`
  (`services/transcriptService.ts:62`) и складывает в буфер порядка в
  `TranscriptContext` (`contexts/TranscriptContext.tsx:297-346`).
- Сегменты живут в React-state `transcripts: Transcript[]`
  (`contexts/TranscriptContext.tsx:32`, `417-463`), плюс пишутся в IndexedDB для
  восстановления (`TranscriptContext.tsx:334-337`, `services/indexedDBService.ts:230`).
- **Ключевой факт:** у «живых» сегментов `id` генерируется на фронте
  (`${Date.now()}-${counter}`, `TranscriptContext.tsx:316`, `426`) — **это не
  идентификаторы строк БД**. Настоящий `transcript-<uuid>` появляется только после
  сохранения встречи. Значит правка текста возможна только там, где у строки есть
  DB-id, то есть **на странице встречи после сохранения**, а не в живой панели записи.

### 2. Сохранение встречи

- По остановке записи `useRecordingStop` вызывает `storageService.saveMeeting`
  (`hooks/useRecordingStop.ts:287`), который вызывает Tauri-команду
  `api_save_transcript` (`services/storageService.ts:44`).
- `api_save_transcript` (`api/api.rs:1239`) → `TranscriptsRepository::save_transcript`
  (`database/repositories/transcript.rs:14-123`): вставляет встречу и каждую строку в
  таблицу `transcripts` (`transcript.rs:89-111`) с полями `id, meeting_id, transcript,
  timestamp, audio_start_time, audio_end_time, duration, speaker`.

### 3. Чтение и отображение транскрипта (страница встречи)

- Страница `/meeting-details` (`app/meeting-details/page.tsx`) через
  `usePaginatedTranscripts` (`hooks/usePaginatedTranscripts.ts`) читает сегменты
  постранично командой `api_get_meeting_transcripts` (`usePaginatedTranscripts.ts:115-122`;
  Rust `api/api.rs:1022` → `MeetingsRepository::get_meeting_transcripts_paginated`,
  `database/repositories/meeting.rs:155-193`, сортировка `ORDER BY audio_start_time ASC`).
- Данные приходят как `Transcript[]` (`types/index.ts:7-23`) и конвертируются в
  `TranscriptSegmentData[]` (`usePaginatedTranscripts.ts:37-47`, `types/index.ts:169-179`).
- Отображение: `TranscriptPanel` (`components/MeetingDetails/TranscriptPanel.tsx`) →
  `VirtualizedTranscriptView` (`components/VirtualizedTranscriptView.tsx`).
  - Список строками (`mb-3`), виртуализация через `@tanstack/react-virtual`
    (`VirtualizedTranscriptView.tsx:4`, `275-285`; порог 10 строк, `:67`).
  - Каждая строка — мемоизированный `TranscriptSegment`
    (`VirtualizedTranscriptView.tsx:90-239`): слева таймкод `formatRecordingTime(timestamp)`
    (`:213`), затем чип спикера (`:159-205`), затем текст
    `<p className="text-base ...">{displayText}</p>` (`:230`/`:233`).
  - Текст на экране дополнительно чистится от слов-паразитов **только для показа**
    (`cleanStopWords`, `VirtualizedTranscriptView.tsx:77-87`, `117`) — исходный
    `text` в данных не меняется. Это важно: правим мы именно хранимый `text`, а не
    очищенный.
  - Чип спикера редактируется дропдауном `DropdownMenu` → `invoke('api_set_transcript_speaker')`
    (`VirtualizedTranscriptView.tsx:151`), но только когда запись не идёт
    (`allowSpeakerEdit={!isRecording}`, `:441`, `:502`).

### 4. Модель данных на Rust-стороне

- Строка транскрипта — `Transcript` (`database/models.rs:32-56`):
  `id, meeting_id, transcript (TEXT NOT NULL), timestamp, summary, action_items,
  key_points, audio_start_time, audio_end_time, duration, speaker`, плюс
  не-колоночный `speaker_name` (резолвится из карты имён встречи, `models.rs:49-55`).
- Схема таблицы `transcripts` — `frontend/src-tauri/migrations/20250916100000_initial_schema.sql`
  + миграции: `speaker` (`20251110000001_add_speaker_field.sql`), поля синхронизации
  аудио (`20251006000000_add_audio_sync_fields.sql`). **Колонки «отредактировано» нет.**
- Migrations применяются через `sqlx::migrate!("./migrations")`
  (`database/manager.rs:35`).

### 5. Существующие команды, несущие текст транскрипта

| Команда | Что делает | Файл |
|---|---|---|
| `api_save_transcript` | Создаёт встречу + строки транскрипта (вставка) | `api/api.rs:1239` |
| `api_get_meeting_transcripts` | Читает сегменты страницы (текст + тайминги + спикер) | `api/api.rs:1022` |
| `api_search_transcripts` | LIKE-поиск по `t.transcript` | `api/api.rs`, `transcript.rs:127-161` |
| `api_set_transcript_speaker` | **Правка одной строки (только `speaker`)** | `api/api.rs:1134`, репозиторий `speaker.rs:524-566` |
| `api_save_meeting_title` | Правка заголовка/даты встречи | `api/api.rs:1184` |
| `api_save_meeting_summary` | Сохранение текста саммари (BlockNote) | `summary/commands.rs:95` |

`api_set_transcript_speaker` — это готовый образец «правки отдельного поля одной
строки транскрипта»: читает строку, сравнивает, `UPDATE transcripts SET speaker = ?
WHERE id = ?`, в том же транзакте поднимает `meetings.updated_at`
(`speaker.rs:538-566`). Новая команда правки текста должна строиться по этому же
шаблону.

### 6. Перетранскрибация (риск перезаписи правок)

- Кнопка «Улучшить» (`TranscriptButtonGroup.tsx:109-122`) открывает `RetranscribeDialog`.
- `audio/retranscription.rs` в транзакции делает `DELETE FROM transcripts WHERE
  meeting_id = ?` (`:543`) и заново вставляет новые сегменты (`:548-563`), затем
  сверяет имена спикеров (`:567`). **Любые правки текста будут потеряны при
  перетранскрибации** — это надо явно обработать (см. «Краевые случаи»).
- Диаризация же правит только `speaker`, не текст (`audio/transcription/diarization_run.rs:349`),
  и обновляет открытую страницу событием `transcript-updated`
  (`hooks/useTranscriptUpdatedListener.ts`, `lib/diarization.ts:170`).

---

## Используемые веб-компоненты (стек)

Стек проверен по `frontend/package.json` и фактическим импортам. **MUI в проекте
отсутствует** (grep по `@mui`/`material-ui` в `package.json`/`src` пуст) — не путать с
конвенцией React 18 + FSD + MUI 5.

| Роль | Библиотека (версия) | Где уже используется |
|---|---|---|
| Фреймворк | Next.js `^14.2.25`, React `^18.2.0` | весь `frontend/src` |
| Компонентная база | Radix UI (`@radix-ui/*` `^1.x`, `radix-ui ^1.4.3`) + shadcn-обёртки в `components/ui/*` | `components/ui/{dialog,dropdown-menu,button,input,textarea,popover,command,scroll-area,...}.tsx` |
| Стили | Tailwind `^3.4.1`, `clsx`, `tailwind-merge`, `cva` | всюду; утилитa `lib/utils.ts` |
| Виртуализация списка | `@tanstack/react-virtual ^3.13.13` | `VirtualizedTranscriptView.tsx:4` |
| Богатый текст (блок-редактор) | **BlockNote** `@blocknote/core|react|shadcn 0.36.0` | саммари: `components/BlockNoteEditor/Editor.tsx`, `components/AISummary/BlockNoteSummaryView.tsx` |
| Markdown | `react-markdown ^9`, `remark-gfm ^4`; BlockNote парсит/сериализует markdown | `BlockNoteSummaryView.tsx:106` (`tryParseMarkdownToBlocks`), `lib/blocknote-markdown.ts` |
| Анимации | `framer-motion ^11` | `VirtualizedTranscriptView` (простые списки), `TranscriptView` |
| Тосты | `sonner ^2.0.7` | `VirtualizedTranscriptView.tsx:7`, `155` |
| Иконки | `lucide-react ^0.469`, `@heroicons/react` | кнопки, чипы |
| Формы | `react-hook-form`, `@hookform/resolvers`, `zod` | `components/molecules/form-components` |
| Tauri | `@tauri-apps/api ^2.6.0` | `invoke`/`listen` по всему фронту |

Примечание: в `package.json` есть `@tiptap/*` (`^2.10.4`, строки 53-55) и `@remirror/*`
(строки 36-44), но grep по `src` показывает, что **в коде они не импортируются** —
реально редактируемый rich-text идёт через BlockNote. Значишь Tiptap/Remirror — «мёртвые»
зависимости, новую правку на них опирать не следует.

### Готовые «редактируемые» паттерны, уже присутствующие в проекте

Это то, на что можно опереться с нулём новых зависимостей:

1. **Inline edit-in-place на `<textarea>` (click-to-edit, save on blur/Enter)** —
   `components/EditableTitle.tsx:40-58`: клик по `<h1>` → авто-ресайз `<textarea>`,
   `onBlur`/`Enter` завершают правку, `Shift+Enter` — перенос строки. Уже используется
   для правки заголовков секций саммари (`AISummary/Section.tsx:67`).
2. **Многострочное редактирование блока текста с авто-высотой и слэш-командами** —
   `components/AISummary/Block.tsx:70-120` (правый textarea + команда `COMMANDS`).
3. **Панель с textarea-инпутом** — `MeetingDetails/TranscriptPanel.tsx:117-125` (custom
   prompt под транскриптом) и shadcn `components/ui/textarea.tsx`.
4. **Модальное окно** — `components/ui/dialog.tsx` (Radix Dialog) и обёртка
   `components/CustomDialog.tsx`; примеры модальных сценариев: `RetranscribeDialog`,
   `SpeakersPanel`, `ModelSettingsModal`.
5. **Полноценный блок-редактор** — BlockNote `Editor.tsx` (уже работает как
   редактируемое саммари: `BlockNoteSummaryView.tsx:247-283`, `editable={true}`).
6. **Паттерн оптимистичного обновления строки** — `TranscriptSegment` держит локальный
   `override` до прихода данных с бэкенда (`VirtualizedTranscriptView.tsx:121-124`),
   а хук `usePaginatedTranscripts.setTranscriptSpeaker` (`:226-236`) обновляет строку
   in-place без перезагрузки страницы; страница встречи подключает это через
   `handleSpeakerChanged` (`app/meeting-details/page.tsx:87-93`). Тот же механизм
   переносится на текст.

---

## Варианты реализации

Все варианты работают на странице встречи (`/meeting-details`), где у строки есть
настоящий DB-id. Правка доступна при `!isRecording`.

### Вариант (a) — Inline-правка текста сегмента (рекомендуемый)

Клик по тексту строки в `TranscriptSegment` (`VirtualizedTranscriptView.tsx:222-234`)
превращает `<p>` в редактируемый `<textarea>` по образцу `EditableTitle.tsx`;
`Enter`/`blur` — сохранить, `Escape` — отменить; `Shift+Enter` — перенос.
Сохранение — новая Tauri-команда (см. ниже), затем оптимистичное обновление строки через
новый метод в `usePaginatedTranscripts` (по образцу `setTranscriptSpeaker`).

Плюсы:
- Использует только уже имеющиеся компоненты (`<textarea>`/`ui/textarea`, Tailwind,
  `sonner` для обратной связи, `lucide` для иконки «карандаш» при hover — ровно как
  кнопка edit у `EditableTitle.tsx:69-87`). Нулём новых зависимостей.
- Минимальный диф: правим один компонент `TranscriptSegment` + один хук + одну команду.
- Сохраняются `timestamp`, `audio_start_time`, `audio_end_time`, `speaker`
  (меняется только `transcript`), потому что `UPDATE` трогает одну колонку.
- Соответствует уже принятому в проекте UX правки строки (дропдаун спикера на той же строке).

Минусы:
- Виртуализированный список (`@tanstack/react-virtual`) перемеряет высоты
  (`measureElement`, `:421`); при редактировании высота строки меняется — нужно
  `measurable`-обновление/`rerender` (в компоненте уже есть `rerender`-редьюсер, `:265`).
- `cleanStopWords` меняет вид на экране (`:117`); редактор должен показывать **исходный**
  `text`, а не очищенный, иначе правка «съест» показанные слова-паразиты.
- Правка в live-панели записи невозможна (нет DB-id) — только на странице встречи.

### Вариант (b) — Модальный редактор сегмента

Кнопка/иконка на строке открывает Radix `Dialog` (`ui/dialog.tsx` / `CustomDialog.tsx`)
с `ui/textarea` для текста и (опционально) выбором спикера; кнопки Сохранить/Отмена.

Плюсы:
- Не конфликтует с виртуализацией (редактор вне списка).
- Легко добавить валидацию (пустой текст), счётчик символов, подтверждение.
- Единый паттерн с `RetranscribeDialog`/`SpeakersPanel` — согласуется с проектом.

Минусы:
- Больше кликов для «исправить опечатку»; тяжелее для частой мелкой правки.
- Нужно вручную синхронизировать состояние строки после сохранения (тот же
  оптимистичный апдейт, что и в (a)).

### Вариант (c) — Редактирование всего транскрипта как BlockNote/Markdown

Открыть весь транскрипт встречи в существующем BlockNote-редакторе (`Editor.tsx`) или
в режиме markdown, редактировать как единый документ, затем разобрать обратно в строки.

Плюсы:
- Rich-text уже «на полке» (BlockNote 0.36 работает для саммари).
- Удобно для массовой переработки текста/структуры.

Минусы (критично):
- **Разрыв связки «документ ↔ строки БД».** Строки несут тайминги
  (`audio_start_time/audio_end_time/duration`) и `speaker` — при свободном
  редактировании markdown/блоков маппинг «блок → сегмент» теряется при слиянии/разбиении
  строк, и их метаданные станет нечем сохранить. Придётся либо запретить структурные
  правки (тогда зачем rich-text), либо хранить «сырой» текст отдельно и потерять
  синхронизацию с аудио.
- BlockNote не является «источником истины» для транскрипта сегодня; его формат (`Block[]`
  с `content[]`) не сопоставим 1:1 с плоским `text` сегмента.
- Тяжелее тестировать и держать контракты Tauri.

### Итог по вариантам

(a) — прямой, с нулём новых зависимостей, сохраняет все поля строки и ложится в
существующие паттерны. (b) — хороший вариант для «аккуратной» правки; его можно добавить
вторым шагом как надстройку над тем же save-путём. (c) не рекомендуется как основной:
он разрушает связь сегмент↔тайминги↔спикер.

---

## Рекомендация

Реализовать **инлайн-редактирование текста сегмента на странице встречи** (вариант a):
клик по тексту строки `TranscriptSegment` открывает авто-ресайз `<textarea>` по образцу
`EditableTitle.tsx`, сохранение по `Enter`/`blur`, отмена по `Escape`, с оптимистичным
обновлением строки и тостом `sonner` при ошибке. Единственная новая зависимость — ноль;
используются Radix/`ui/textarea`, Tailwind, `lucide`, `sonner`, уже подключённые в
`VirtualizedTranscriptView`. По желанию вторым шагом добавить модальный редактор
(`ui/dialog`) поверх того же save-пути (вариант b). Правку разрешить только при
`!isRecording` (как `allowSpeakerEdit`), чтобы не пытаться редактировать live-строки без
DB-id.

---

## Изменения на Rust-стороне и контракты Tauri

### Новая команда сохранения текста одной строки

По образцу `api_set_transcript_speaker` (`api/api.rs:1134`, `speaker.rs:524-566`):

- `#[tauri::command] api_update_transcript_text(app, state, transcript_id: String,
  text: String)` → `TranscriptsRepository::update_text(pool, &transcript_id, &text)`.
- Тело: `SELECT meeting_id FROM transcripts WHERE id = ?` (проверка существования,
  как `speaker.rs:538-546`); `UPDATE transcripts SET transcript = ? WHERE id = ?`;
  в той же транзакции `UPDATE meetings SET updated_at = ? WHERE id = ?` (как
  `speaker.rs:561-564`). Отдельного события эмитить не обязательно: фронт обновит
  строку оптимистично; при желании — переиспользовать событие `transcript-updated`
  (`lib/diarization.ts:170`, слушатель `useTranscriptUpdatedListener`), но это
  перезагрузит страницу, что для инлайн-правки избыточно.
- Зарегистрировать команду в `tauri::generate_handler![...]`
  (`lib.rs:705-...`, рядом с `api::api_set_transcript_speaker`, `lib.rs:788`).
- Валидация: пустой/whitespace-only текст разрешать или нет — решить явно; если
  «нельзя пусто» — вернуть `Err`, фронт покажет `toast.error` (паттерн
  `VirtualizedTranscriptView.tsx:155`).

### Миграция БД (флаг «отредактировано») — опционально, но рекомендуется

Если нужно показывать, что строка правилась вручную (и не «перетирать» её при
будущих операциях):

- Новая миграция в `frontend/src-tauri/migrations/` (sqlx применяет каталог,
  `manager.rs:35`) по образцу `20251110000001_add_speaker_field.sql`:
  `ALTER TABLE transcripts ADD COLUMN edited_at TEXT;` (NULL = не редактировалась).
  `ALTER TABLE ... ADD COLUMN` безопасен для существующих БД.
- Добавить поле в `Transcript` (`database/models.rs:32-56`) как
  `#[sqlx(default)] pub edited_at: Option<String>` и прокинуть в `MeetingTranscript`
  (`api/api.rs:156`) и `TranscriptSegmentData`/`Transcript` на фронте
  (`types/index.ts`) — все новые поля делать `#[serde(default, skip_serializing_if =
  "Option::is_none")]`, чтобы контракт остался обратно совместимым (тот же приём, что
  `speaker_name`, `models.rs:53-55`).
- Команда `update_text` пишет `edited_at = now`.

Без флага минимальный путь правки работает сразу: `transcript` уже `TEXT NOT NULL`,
достаточно `UPDATE`.

### Контракты и читали

- `api_get_meeting_transcripts` (`api/api.rs:1022`) возвращает `MeetingTranscript.text`
  = колонка `transcript` (`api/api.rs` маппинг `text: t.transcript`, `:1053`), так что
  после правки чтение сразу отдаёт новый текст — менять чтение не нужно.
- Копирование/экспорт (`lib/transcript-format.ts:147-171`) и payload для саммари
  (`lib/summary-transcript-payload.ts:26-43`) читают `t.text` из тех же данных — после
  обновления строки в state они автоматически подхватят правку. Отдельных правок нет.

---

## Краевые случаи (обязательно учесть в плане)

1. **Правка во время записи.** Live-строки не имеют DB-id
   (`TranscriptContext.tsx:316`, `426`) — правку в live-панели (`app/_components/TranscriptPanel.tsx`)
   не разрешать; редактирование только на странице встречи после `api_save_transcript`.
   Ориентир — уже существующий флаг `allowSpeakerEdit={!isRecording}`
   (`VirtualizedTranscriptView.tsx:441`, `502`).
2. **Перетранскрибация затирает правки.** `audio/retranscription.rs:543` делает
   `DELETE FROM transcripts` + повторную вставку (`:548`). Нужно: предупредить в
   `RetranscribeDialog`, что правки будут потеряны; при наличии `edited_at` (если ввели
   флаг) — предлагать подтверждение. Полностью сохранить правки при перетранскрибации
   сложно (меняется число/границы сегментов) — достаточно явного предупреждения.
3. **Диаризация не трогает текст** (`diarization_run.rs:349` меняет только `speaker`) —
   конфликта с правкой текста нет; но событие `transcript-updated` перезагружает страницу
   (`useTranscriptUpdatedListener`), поэтому несохранённую правку (открытый textarea)
   надо дописывать/закрывать перед перезагрузкой либо игнорировать перезагрузку для
   строки в режиме правки.
4. **Тайминги и спикер сохраняются.** `UPDATE` меняет только `transcript`
   (`audio_start_time/audio_end_time/duration/speaker` остаются), воспроизведение по
   строке (`AudioPlayer`, `hooks/useAudioPlayer.ts`) и синхронизация не ломаются.
   Разбиение/слияние строк (правки, меняющие границы) вне скоупа — при них тайминги
   некуда сохранить.
5. **`cleanStopWords` для показа.** Редактор должен редактировать хранимый `text`, а не
   очищенный экраном вариант (`VirtualizedTranscriptView.tsx:77-87`, `117`), иначе
   сохранение «потеряет» показанные слова-паразиты.
6. **Undo/Cancel.** `Escape` отменяет правку, возвращая исходный `text` (локальный
   state строки); отмена не вызывает команду. Для «отменить уже сохранённое» —
  secondary-действие «вернуть оригинал» требует хранения исходного текста
   (отдельная колонка `original_transcript`) — вынести в backlog, не в MVP.
7. **Autosave vs явное сохранение.** Рекомендуемый дефолт — сохранение на `blur`/`Enter`
   (как `EditableTitle.tsx:46`, `onBlur={onFinishEditing}`), тост об ошибке при
   неудаче (`VirtualizedTranscriptView.tsx:155`). Autosave «на каждое нажатие» — лишний
   трафик через Tauri и гонки; не делать.
8. **Виртуализация/высота.** Меняющаяся высота textarea в виртуализированной строке
   требует перемера (`measureElement`, `:421`; `rerender`, `:265`); при малых списках
   (`< 10`, `:362`) анимации `framer-motion` (`:485-490`) тоже стоит не ломать.
9. **Пустой текст.** Решить политику (запрет пустого/whitespace — вернуть ошибку
   командой и тостом, либо разрешить «тишину»).
10. **Поиск по транскрипту** (`api_search_transcripts`, `transcript.rs:127-161`) читает
    ту же колонку `transcript` — правки автоматически отразятся в поиске.

---

## Примерная декомпозиция задач (шаги без кода)

1. **Rust: команда правки текста.**
   - Репозиторий: `TranscriptsRepository::update_text` (или новый метод рядом) —
     проверка существования строки, `UPDATE transcripts SET transcript = ?`, bump
     `meetings.updated_at`, в одном транзакте. Тесты по образцу `speaker.rs:524+`.
   - Команда `api_update_transcript_text` в `api/api.rs` + регистрация в `lib.rs`
     (`generate_handler!`, рядом с `api_set_transcript_speaker`, `lib.rs:788`).
2. **Rust: миграция флага (опционально, но рекомендовано).**
   - `migrations/<ts>_add_transcript_edited_at.sql` (`ALTER TABLE transcripts ADD
     COLUMN edited_at TEXT;`); поле в `Transcript` (`models.rs:32`), `MeetingTranscript`
     (`api/api.rs:156`) с `serde(default, skip_serializing_if)`; запись `edited_at`
     в `update_text`. Миграционный тест по образцу `database/migrations_tests.rs`.
3. **Frontend: типы.**
   - Добавить `edited_at?` (и что нужно) в `Transcript`/`TranscriptSegmentData`
     (`types/index.ts:7`, `169`).
4. **Frontend: хук состояния.**
   - `usePaginatedTranscripts`: новый метод `setTranscriptText(transcriptId, text)` —
     оптимистичный in-place апдейт (по образцу `setTranscriptSpeaker`, `:226-236`).
5. **Frontend: UI инлайн-правки.**
   - В `TranscriptSegment` (`VirtualizedTranscriptView.tsx:90-239`) добавить
     click-to-edit `<textarea>` (по образцу `EditableTitle.tsx:40-58`) вместо `<p>`
     при редактировании; `Enter`/`blur` — `invoke('api_update_transcript_text')` +
     локальный апдейт через `setTranscriptText`, `Escape` — откат; иконка-карандаш на
     hover (как `EditableTitle.tsx:69-87`).
   - Гейт `!isRecording` (как `allowSpeakerEdit`). Пробросить колбэк
     `onTextChange` через `VirtualizedTranscriptView` props → `MeetingDetails/
     TranscriptPanel.tsx` → `app/meeting-details/page.tsx` (по образцу
     `onSpeakerChange`/`handleSpeakerChanged`, `page.tsx:87-93`).
   - Редактировать исходный `text`, а не вывод `cleanStopWords` (`:117`).
6. **Frontend: обратная связь.**
   - `sonner` тосты успех/ошибка (паттерн `VirtualizedTranscriptView.tsx:155`);
     ошибки — user-friendly, без приватного содержимого (`AGENTS.md` guardrails).
7. **(Опционально) модальный редактор** (`ui/dialog` / `CustomDialog.tsx`) поверх того
   же save-пути для «аккуратной» правки длинных сегментов.
8. **Предупреждение о перетранскрибации.**
   - В `RetranscribeDialog` — текст, что ручные правки будут потеряны; при `edited_at`
     (если добавлен) — повышенное подтверждение.
9. **Тесты.**
   - Rust: `TranscriptsRepository::update_text` + миграция (в стиле
     `repositories/speaker.rs`, `migrations_tests.rs`).
   - Frontend (bun:test + react-test-renderer, `frontend/tests/hooks/*`): оптимистичный
     `setTranscriptText` (по образцу `tests/hooks/paginated-transcripts.test.tsx`),
     компонентный тест инлайн-правки (по образцу `tests/components/speakers-panel.test.tsx`).
   - Проверка контракта: после правки `api_get_meeting_transcripts`, копирование
     (`formatTranscriptText`, `lib/transcript-format.ts:147`) и export дают новый текст.
10. **Верификация в Tauri-приложении** (`pnpm run tauri:dev`, из `frontend/`):
    открыть сохранённую встречу, отредактировать строку, убедиться, что правка
    сохранилась после перезагрузки страницы/приложения, копипаст/экспорт/поиск и
    пересоздание саммари (`handleRegenerateSummary`, `useSummaryGeneration.ts:440`)
    используют исправленный текст. Записать, что реально проверялось, платформу и что
    осталось непроверенным (`AGENTS.md` «Verification and Privacy»).

---

## Ключевые файлы, от которых зависит план

- `frontend/src/components/VirtualizedTranscriptView.tsx` — строка транскрипта, точка
  встраивания инлайн-редактора (`TranscriptSegment`, `:90-239`).
- `frontend/src/components/EditableTitle.tsx` — готовый паттерн click-to-edit textarea
  (`:40-58`).
- `frontend/src/components/MeetingDetails/TranscriptPanel.tsx` и
  `frontend/src/app/meeting-details/page.tsx` — контейнеры и проброс колбэков
  (`page.tsx:87-93`, `:203-225`).
- `frontend/src/hooks/usePaginatedTranscripts.ts` — состояние сегментов и оптимистичный
  апдейт (`setTranscriptSpeaker`, `:226-236`).
- `frontend/src/services/transcriptService.ts`, `contexts/TranscriptContext.tsx` —
  живой транскрипт и события (`transcript-update`).
- `frontend/src/lib/summary-transcript-payload.ts` (`:26`) и
  `frontend/src/hooks/meeting-details/useSummaryGeneration.ts` (`:347`, `:440`) —
  связь «текст → саммари».
- `frontend/src-tauri/src/api/api.rs` (`api_get_meeting_transcripts:1022`,
  `api_set_transcript_speaker:1134`, `api_save_transcript:1239`) и
  `frontend/src-tauri/src/lib.rs` (`generate_handler!` `:705`, регистрация `:788`).
- `frontend/src-tauri/src/database/repositories/speaker.rs` (`set_transcript_speaker:524-566`) —
  шаблон UPDATE-команды; `database/repositories/meeting.rs` (`:155`) — чтение;
  `database/models.rs:32-56` — модель `Transcript`.
- `frontend/src-tauri/migrations/` (`initial_schema.sql`, `20251110000001_add_speaker_field.sql`)
  — куда добавляется миграция `edited_at`.
- `frontend/src-tauri/src/audio/retranscription.rs` (`:543-563`) — риск потери правок.
- `frontend/package.json` — стек (Radix + shadcn `components/ui/*`, BlockNote 0.36,
  `@tanstack/react-virtual` 3.13, `sonner`, `lucide`; **MUI нет**; Tiptap/Remirror не
  используются).
