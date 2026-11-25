# 04: Перенос поля дополнительного контекста саммаризации на панель саммари

**What to build:** Поле ввода дополнительного контекста саммаризации (custom prompt) убрано из нижней части панели транскрипта и показано на панели саммари, визуально рядом с группой Generate (конкретное размещение — в тулбаре-поповере или над содержимым — по месту). Условие показа сохранено: не во время записи и при наличии речевых сегментов. Состояние текста поля остаётся на странице встречи, потребитель (кнопка Generate/Regenerate) не меняется.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] Поле контекста видно на панели саммари и отсутствует на панели транскрипта
- [x] Условия показа сохранены: скрыто во время записи, видно при наличии речевых сегментов
- [x] Введённый текст доезжает до генерации саммари (пропсовая связь со страницей встречи не сломана)
- [x] Тест на page-level харнессе (пропсы заглушек панелей) подтверждает новое расположение поля

## Comments

Реализация (коммит `d172b27`):

- **Панель саммари** (`SummaryPanel.tsx`): новые пропсы `onPromptChange: (value: string) => void` (обязательный) и `isRecording?: boolean` (default false); textarea в шапке (`p-4 border-b`) сразу под рядом кнопки Generate — оба элемента видны одновременно. Условие показа `!isRecording && transcripts.length > 0`; эквивалентность прежнему `convertedSegments.length > 0` подтверждена: `convertTranscriptsToSegments` — чистый 1:1 `.map()` без фильтрации (`usePaginatedTranscripts.ts:63`).
- **Панель транскрипта** (`TranscriptPanel.tsx`): поле и пропсы `customPrompt`/`onPromptChange` удалены (page-content — единственный колл-сайт); неиспользуемые импорты i18n убраны.
- **Страница** (`page-content.tsx`): состояние `customPrompt` не переехало — сменился только получатель пропсов (SummaryPanel вместо TranscriptPanel); потребитель (Generate/Regenerate) не тронут.
- **Тесты**: новые `meeting-details-custom-prompt.test.tsx` (5, seam-1 page-level: пропсы доезжают до заглушки SummaryPanel и не доезжают до TranscriptPanel) и `summary-panel-custom-prompt.test.tsx` (4, реальная панель: условия показа, ввод, рендер независимо от состояния саммари); адаптированы фабрики пропсов в `panel-meeting-date` и `summary-panel-search-button`. Gotcha: рендер реальной SummaryPanel с непустыми transcripts монтирует `LanguagePickerPopover`, которому нужен `document` — замокан в seam-2 сьюте.
- **Проверки**: bun пофайлово — новые 5/5 и 4/4, соседние сьюты зелёные, полный прогон без регрессий (fail-сет байт-в-байт как на базе); `tsc --noEmit` — только baseline-ошибка.
