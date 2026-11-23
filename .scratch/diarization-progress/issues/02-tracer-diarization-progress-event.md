# 02: Трейсер — событие `diarization-progress` видно в панели Speakers при ручном запуске

**What to build:** Первый сквозной путь: пользователь нажимает «Запустить диаризацию» в панели Speakers и вживую видит стадии прохода — «Ожидание очереди», «Загружаем модель…», «Анализируем аудио…», «Определяем спикеров…». Бэкенд эмитит новое событие `diarization-progress` с payload `{meeting_id, stage, progress_percentage?, message}` (процент только там, где он честно считаем; на indeterminate-стадиях поля процента нет). Фронтенд держит общий стейт прохода по `meeting_id` в seam-модуле диаризации — один слушатель обслуживает панель Speakers, будущие диалоги и live-stop.

**Blocked by:** 01 — Подготовка: эмиттер событий в цепочке прохода диаризации.

**Status:** ready-for-human

- [x] Проход диаризации эмитит `diarization-progress` со стадиями `queued → loading_model → decoding → inferring → applying_labels`; терминальные события не изменились
- [x] `progress_percentage` присутствует только на стадиях с честным процентом; на инференсе — indeterminate (спиннер без числа)
- [x] В панели Speakers во время прохода видна строка текущей стадии со спиннером; кнопка «Запустить диаризацию» задизейблена
- [x] Стейт прохода по `meeting_id` живёт в seam-модуле диаризации и доступен другим потребителям; тесты редьюсера стейта на фейковых событиях `diarization-progress` (переходы стадий, терминалы)
- [ ] Ручная проверка в Tauri: ручной запуск диаризации показывает стадии в панели Speakers до появления спикеров

## Comments

Имплементация (тикент 02), ветка `feat/dp-02`:

- Бэкенд: `DiarizationStage` / `DiarizationPhase` / `DiarizationProgressEvent` и
  чистый маппер `diarization_progress_event` лежат в `diarization_service.rs`
  (там же, где остальные имена событий и тексты — фронт зеркалит их через
  `tests/lib/live-diarization.test.ts`). Эмиссии — только в async-обёртках
  (`diarize_saved_meeting`, `diarize_recording_folder_with_model`,
  `run_diarization`); spawn_blocking-коллбэки и session-тред движка эмитить не
  трогают.
- Честный процент: загрузка модели (0 → 100) и запись лейблов (0 → 100). У
  загрузки нативной модели нет промежуточных данных, поэтому честный процент —
  это чекпоинты вокруг работы, как в `retranscription.rs` («Loading
  transcription engine… 25»). `queued`/`decoding`/`inferring` — indeterminate:
  ключа `progress_percentage` в payload нет.
- `queued` эмитится после решения и до взятия `DIARIZATION_PASS_LOCK`. Чтобы
  `no_model`/`no_runtime`/`deferred` оставались молчаливыми (спека), чтение
  встречи и `decide_diarization` перенесены за лок; авторитетная проверка
  записи выполняется под локом (запись могла начаться, пока проход ждал
  очереди) и возвращает тихий `deferred`.
- Фронтенд: `DiarizationPassStore` и `applyDiarizationProgress` в
  `frontend/src/lib/diarization.ts`; продакшн-синглтон в
  `frontend/src/lib/diarizationPassStore.ts`. Один слушатель
  `diarization-progress` + три терминала, стейт по `meeting_id`. Панель
  Speakers читает стор через `useSyncExternalStore`: строка стадии + спиннер
  (+ процент где есть) видна и при автоматическом проходе, кнопка ручного
  запуска disabled во время прохода.
- Проверено: `cargo test -p samobranka --lib` 739 pass; `bun test` новых/
  затронутых файлов зелёные; `tsc --noEmit` без новых ошибок; `i18n-parity` и
  `i18n-usage` зелёные. Ручная проверка в Tauri-приложении не выполнялась
  (GUI не запускался) — пункт остаётся за тикетом.
