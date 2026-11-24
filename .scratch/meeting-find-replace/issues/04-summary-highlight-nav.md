# 04: Подсветка и навигация по саммари

**What to build:** Открытая панель поиска теперь считает совпадения и по саммари встречи: по текстовому содержимому редактора саммари во всех форматах (BlockNote / markdown / legacy). Совпадения подсвечиваются внутри редактора (decorations; фолбэк, если decorations хрупкие — подсветка только активного совпадения через выделение), текущее отличается визуально и прокручивается в зону видимости. Общий список совпадений идёт «сначала речевые сегменты, затем саммари»: навигация ↑/↓ из конца транскрипта переходит в саммари и обратно, счётчик «текущее / всего» общий. В мобильной раскладке переход к совпадению в скрытой области автоматически переключает активную вкладку сплит-вида. В шапке панели саммари появляется кнопка-лупа, открывающая ту же панель.

**Blocked by:** 02 (Панель поиска + навигация по транскрипту).

**Status:** ready-for-human

- [x] Совпадения находятся и подсвечиваются в саммари всех трёх форматов (BlockNote, markdown, legacy), только внутри текстового содержимого
- [x] Навигация ↑/↓ идёт по общему списку «транскрипт → саммари» с автоскроллом в обе стороны
- [x] Переключение форматирования саммари (заголовки, списки) остаётся нетронутым при подсветке
- [x] На мобильном переход к совпадению в другой области переключает вкладку
- [x] Кнопка-лупа в шапке саммари открывает панель
- [x] Тесты поведения хука: общий порядок совпадений и счётчик при обоих текстах
- [ ] Проверено вручную в `tauri:dev` (BlockNote-саммари)

## Решения реализации

- **Decorations, не фолбэк.** BlockNote 0.36 не имеет `editor.ui.buildEditorDecorations`,
  поэтому подсветка — сырой ProseMirror-плагин (`src/lib/summary-find-decorations.ts`:
  `DecorationSet` state-field + meta-транзакции) через `BlockNoteExtension.addProsemirrorPlugin`
  (`components/BlockNoteEditor/FindHighlightExtension.ts`, пробрасывается в
  `useCreateBlockNote({ extensions })`). Плагин проверен headless против РЕАЛЬНОЙ
  модели ProseMirror (`tests/lib/summary-find-decorations.test.ts`): классы
  активного/обычного совпадения, маппинг при правках документа, очистка.
  Маппинг «блок/смещения → PM-позиции» — `src/lib/summary-find-reveal.ts`
  (`mapBlockTextRangeToPositions`, `applyFindHighlights`), тоже проверен против
  реального PM (срез текста по позициям совпадает с текстом блока).
  Фолбэк (выделение активного через selection) не понадобился.
- **Legacy (textarea-строки):** фолбэк из спеки — активное совпадение выбирается
  через `setSelectionRange` + `scrollIntoView` по `data-block-id` (см.
  `BlockNoteSummaryView.tsx`). `focus()` намеренно НЕ вызывается: фокус должен
  остаться в поле поиска, иначе Enter/Shift+Enter перестанут навигировать.
  Обычное выделение в unfocused textarea не рисуется, поэтому отдельных
  «очисток» нет. Совпадения для legacy считаются по `block.content`
  (`buildLegacySummaryBlocks`) — заголовки секций и `MeetingName` не ищутся.
- **Форматы BlockNote/markdown:** живые блоки читаются из редактора
  (`editor.document` / `liveEditorRef`), текст блока — конкатенация inline
  content (`buildBlockNoteSummaryBlocks`; текст ссылок включается, вложенные
  блоки идут за родителем и в его текст не входят). Совпадения строго внутри
  одного блока. Markdown — тот же путь (парсится в BlockNote).
- **Общий список:** `useFindReplace` принимает `summaryBlocks` (отчёт
  `onSummaryBlocksChange` от поверхности саммари наверх через SummaryPanel к
  page-content) и строит `[...transcript, ...summary]` одним useMemo; счётчик и
  ↑/↓ общие, циклические.
- **Мобильные вкладки:** эффект в `page-content.tsx` при открытом панели ставит
  активную вкладку по `source` активного совпадения (с пометкой
  `manuallySelectedTabMeetingIdsRef`, чтобы авто-переключение «саммари
  готово» не конфликтовало).
- **Кнопка-лупа:** в верхней секции `SummaryPanel` (рядом с группой Save/Copy/
  Export), lucide `Search`, `onOpenFind` из page-content; i18n-ключ
  `findReplace.openSummaryTooltip` (en+ru).
- **CSS:** `.ProseMirror .find-replace-match(-active)` в `globals.css`,
  палитра как у `<mark>` транскрипта (yellow-100 / yellow-300).
- **Форматирование не трогается:** decorations — только inline-классы на span,
  содержимое не меняется; тест плагина проверяет remapping при вставках/удалениях.

## Проверено

- `bun test` новых и затронутых файлов: 89 pass / 0 fail (см. ниже) —
  `tests/hooks/find-replace.test.tsx`, `tests/lib/summary-match-building.test.ts`,
  `tests/lib/summary-find-reveal.test.ts`, `tests/lib/summary-find-decorations.test.ts`,
  `tests/lib/find-matches.test.ts`, `tests/lib/i18n-parity.test.ts`,
  `tests/lib/i18n-usage.test.ts`,
  `tests/components/find-replace-summary-navigation.test.tsx`,
  `tests/components/summary-panel-search-button.test.tsx`,
  `tests/components/meeting-details-summary-hint.test.tsx`.
- Полный `bun test` — те же 10 падений baseline, что и до изменений
  (кросс-файловая mock-изоляция: rename-export, language/window-title и др.).
- `tsc --noEmit` — чисто (единственная ошибка, `stage-transcribe-native.test.ts`,
  pre-existing, проверено на stash).
- НЕ проверено: `pnpm run tauri:dev` (нет доступа к GUI-сессии) — ручная
  проверка BlockNote/markdown/legacy-саммари, автоскролла, мобильной вкладки и
  вида подсветки осталась за проверяющим.
