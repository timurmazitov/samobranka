'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronsUpDown, Loader2, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DIARIZATION_NO_SPEAKERS_FOUND_MESSAGE,
  DIARIZATION_UNAVAILABLE_HINT,
  diarizationStageMessage,
  diarizationStatusMessage,
  hasInstalledDiarizationModel,
  type DiarizationClient,
  type DiarizationPassStore,
} from '@/lib/diarization';
import type { AudioCppModelClient } from '@/lib/audiocpp';
import { audioCppClient } from '@/lib/audiocppClient';
import { diarizationClient as defaultDiarizationClient } from '@/lib/diarizationClient';
import { diarizationPassStore as defaultPassStore } from '@/lib/diarizationPassStore';
import { comparePersonNames, foldPersonName, personNameKey } from '@/lib/person-sort';
import { formatSpeakerDisplayLabel } from '@/lib/transcript-format';
import type { MeetingSpeaker, SpeakerAssignment } from '@/types';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';

/** `speaker_0` → `Speaker 1`; anything else is shown as-is. */
function displayLabel(label: string): string {
  return formatSpeakerDisplayLabel(label, undefined) ?? label;
}

interface SpeakerNamePickerProps {
  label: string;
  value: string | null;
  /** The whole people directory, already in the shared alphabetical order. */
  names: string[];
  /** Why the directory could not be read, shown inside the open list. */
  directoryError?: string | null;
  /**
   * Folded names already claimed by a row of this panel's draft, mapped to the
   * row labels that claim them. A name is unavailable only when every claimant
   * is another row: the row that holds it in the draft keeps it selectable, so
   * a name can be handed over between rows.
   */
  nameOwners?: ReadonlyMap<string, readonly string[]>;
  disabled?: boolean;
  onValueChange: (name: string | null) => void;
}

/**
 * Popover + Command combobox for one speaker row: "No name", the (optional)
 * create row and the directory names, in that order.
 *
 * The whole directory is handed in once by the panel, already sorted. Typing
 * only filters that list in place — no request, no debounce — so a subset
 * always keeps the alphabetical order of the full list.
 *
 * A person this meeting already gave to another speaker stays in the list but
 * is genuinely unavailable — disabled in cmdk, so it is skipped by the keyboard
 * and fires no selection — and says which speaker holds it. The rule is checked
 * before Done, not left to the backend's error message.
 */
function SpeakerNamePicker({
  label,
  value,
  names,
  directoryError,
  nameOwners,
  disabled,
  onValueChange,
}: SpeakerNamePickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Drop a previous search when the picker closes, so reopening starts fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  /** The other speaker holding this name in the draft, if any. */
  const ownerOf = (name: string): string | null => {
    const folded = personNameKey(name);
    if (!folded) return null;
    const owners = nameOwners?.get(folded);
    if (!owners || owners.length === 0 || owners.includes(label)) return null;
    return displayLabel(owners[0]);
  };

  const trimmed = query.trim();
  const needle = foldPersonName(trimmed);
  const matches = needle
    ? names.filter((name) => foldPersonName(name).includes(needle))
    : names;
  const exactMatch = names.some((name) => personNameKey(name) === needle);
  const canCreate = trimmed.length > 0 && !exactMatch;

  const choose = (name: string | null) => {
    onValueChange(name);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={t('speakers.nameFor', { speaker: displayLabel(label) })}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{value ?? t('speakers.noName')}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[250px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('speakers.searchPeople')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[260px]">
            <CommandGroup>
              <CommandItem value="__no_name__" onSelect={() => choose(null)}>
                <Check
                  className={`mr-2 h-4 w-4 ${value === null ? 'opacity-100' : 'opacity-0'}`}
                />
                <span className="truncate">{t('speakers.noName')}</span>
              </CommandItem>
              {canCreate && (
                <CommandItem value={`__create__${trimmed}`} onSelect={() => choose(trimmed)}>
                  <span className="truncate">{t('speakers.createName', { name: trimmed })}</span>
                </CommandItem>
              )}
              {matches.map((name) => {
                const owner = ownerOf(name);
                const isCurrent = personNameKey(value) === personNameKey(name);
                return (
                  <CommandItem
                    key={name}
                    value={name}
                    disabled={owner !== null}
                    className={owner ? 'opacity-50' : undefined}
                    onSelect={() => choose(name)}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${isCurrent ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <span className="truncate">{name}</span>
                    {owner && (
                      <span
                        data-testid="name-owner"
                        className="ml-auto shrink-0 text-xs text-muted-foreground"
                        title={t('speakers.alreadyAssigned', { owner })}
                      >
                        {owner}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
              {directoryError && (
                <div className="px-2 py-2 text-xs text-red-600">{directoryError}</div>
              )}
              {matches.length === 0 && !canCreate && !directoryError && (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  {t('speakers.noPeopleFound')}
                </div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface SpeakersPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId?: string;
  onRefetchTranscripts?: () => Promise<void>;
  /** Diarization command seam; production uses the Tauri client. */
  diarizationClient?: DiarizationClient;
  /** Model catalog seam: decides whether the manual run button is enabled. */
  modelClient?: Pick<AudioCppModelClient, 'getAvailableModels'>;
  /**
   * Shared diarization pass state seam. Production reads the singleton so an
   * automatic pass (import, retranscription, live stop) shows here even when
   * it was not started from this panel; tests inject a fake driven by
   * `diarization-progress` events.
   */
  passStore?: DiarizationPassStore;
}

/**
 * Right-hand sheet listing the meeting's diarized speakers. Every edit stays in
 * a local draft; Done sends one batch assignment, while Escape / outside click /
 * Cancel just throw the draft away.
 *
 * When the meeting has no labels the panel is no longer a dead end: it offers a
 * manual diarization run, which also covers meetings recorded before the model
 * was downloaded. The run is independent of the transcription provider.
 */
export function SpeakersPanel({
  open,
  onOpenChange,
  meetingId,
  onRefetchTranscripts,
  diarizationClient = defaultDiarizationClient,
  modelClient = audioCppClient,
  passStore = defaultPassStore,
}: SpeakersPanelProps) {
  const { t } = useTranslation();
  const [speakers, setSpeakers] = useState<MeetingSpeaker[]>([]);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [panelError, setPanelError] = useState<string | null>(null);
  // The whole people directory, read once per panel open and handed to every
  // row. A failed read is reported inside each picker and blocks nothing else.
  const [directoryNames, setDirectoryNames] = useState<string[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  // Whether a manual run can start: `true` for an installed model, `false`
  // for a catalog that answered without one, and `null` when the catalog could
  // not be read. `null` is deliberately not `false`: an unreadable list is not
  // knowledge of a missing model, so it must not disable the button forever.
  const [hasDiarizationModel, setHasDiarizationModel] = useState<boolean | null>(false);
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [diarizationReason, setDiarizationReason] = useState<string | null>(null);
  // Guards against a second click landing before the disabled state renders.
  const diarizingRef = useRef(false);

  /**
   * The shared pass state for this meeting. The panel reads the seam store —
   * not only its own `isDiarizing` — so an automatic pass (import,
   * retranscription, live stop) is visible here too and the manual-run button
   * stays disabled while any pass runs, however it was started.
   */
  const subscribePass = useCallback(
    (onChange: () => void) => passStore.subscribe(onChange),
    [passStore],
  );
  const readPass = useCallback(
    () => (meetingId ? passStore.getState(meetingId) : null),
    [passStore, meetingId],
  );
  const passState = useSyncExternalStore(subscribePass, readPass, () => null);

  const loadSpeakers = useCallback(async () => {
    if (!meetingId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const panel = await invoke<MeetingSpeaker[]>('api_get_meeting_speakers', {
        meetingId,
      });
      setSpeakers(panel);
      setDraft(Object.fromEntries(panel.map((row) => [row.label, row.speaker_name ?? null])));
    } catch (error) {
      setLoadError(String(error));
      setSpeakers([]);
      setDraft({});
    } finally {
      setIsLoading(false);
    }
  }, [meetingId]);

  /**
   * Reads the whole people directory. Called once per panel open and again
   * after a successful Done, because saving may have created a person.
   *
   * A failed read is not fatal: the names list stays empty, `No name` and
   * "create from what was typed" keep working, and the error is shown inside
   * the open picker. The user sees a plain sentence; the backend detail stays
   * in the diagnostic log.
   */
  const loadDirectory = useCallback(async () => {
    try {
      const names = await invoke<string[]>('api_get_speaker_names');
      // One sort for the whole panel: every row filters the same ordered list.
      setDirectoryNames([...names].sort(comparePersonNames));
      setDirectoryError(null);
    } catch (error) {
      console.warn('Failed to read the speaker directory:', error);
      setDirectoryNames([]);
      setDirectoryError(t('speakers.directoryUnavailable'));
    }
  }, []);

  // Load on open only (and drop the draft when the sheet closes).
  useEffect(() => {
    if (open) {
      void loadSpeakers();
      void loadDirectory();
    } else {
      setDraft({});
      setRowErrors({});
      setPanelError(null);
      setDiarizationReason(null);
    }
  }, [open, loadSpeakers, loadDirectory]);

  // Whether a manual run can work at all: an installed diarization model. The
  // catalog is the same one the settings section lists, so a downloaded model is
  // immediately usable here.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const loadModels = async () => {
      try {
        const models = await modelClient.getAvailableModels();
        if (!cancelled) setHasDiarizationModel(hasInstalledDiarizationModel(models));
      } catch (error) {
        // An unreadable catalog stays a warning, never a verdict: the panel
        // cannot know there is no model, so it keeps the run available and
        // says the list could not be read. A run then reports the real status.
        console.warn('Failed to read the audio.cpp model list:', error);
        if (!cancelled) setHasDiarizationModel(null);
      }
    };

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [open, modelClient]);

  /**
   * Runs one diarization pass for this meeting and reports the outcome inside
   * the panel: the user pressed a button, so every refusal is shown, unlike the
   * silent automatic path.
   */
  const handleDiarize = async () => {
    // A ref guards against a second click landing before the disabled state
    // renders: two concurrent passes are exactly what native code serializes,
    // and the panel must not queue them either.
    if (
      !meetingId ||
      isDiarizing ||
      hasDiarizationModel === false ||
      diarizingRef.current ||
      // A pass is already running for this meeting — started automatically
      // or from elsewhere; the panel must not queue a second one.
      passState !== null
    ) {
      return;
    }

    diarizingRef.current = true;
    setIsDiarizing(true);
    setDiarizationReason(null);
    setPanelError(null);
    try {
      let result;
      try {
        result = await diarizationClient.diarizeMeeting(meetingId);
      } catch (error) {
        setDiarizationReason(String(error));
        return;
      }

      if (result.status === 'ran') {
        // Labels (and possibly names) changed: reload both the panel's own list
        // and the transcript behind the sheet.
        await loadSpeakers();
        await onRefetchTranscripts?.();
        if (result.labeled_segments === 0) {
          // A pass that found no distinct voices is a success, but an empty
          // list right after a click needs an explanation.
          setDiarizationReason(DIARIZATION_NO_SPEAKERS_FOUND_MESSAGE);
        }
        return;
      }

      const reason = diarizationStatusMessage(result.status);
      // A failed pass carries diagnostic detail; the panel shows it next to the
      // generic message so a support report can quote something concrete.
      const detail = result.status === 'failed' ? result.error : null;
      setDiarizationReason(detail ? `${reason} (${detail})` : reason);
    } finally {
      diarizingRef.current = false;
      setIsDiarizing(false);
      // The command resolved; whatever stages the pass announced are over
      // now. Clearing the shared state keeps the indicator honest even if a
      // terminal event raced past this listener, so a finished manual run
      // cannot leave a stale stage on screen.
      if (meetingId) passStore.clear(meetingId);
    }
  };

  const resetDraft = () => {
    setDraft({});
    setRowErrors({});
    setPanelError(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    // While a save is in flight, Escape / outside click must not close the sheet.
    if (isSaving) return;
    resetDraft();
    onOpenChange(false);
  };

  const setRowValue = (label: string, name: string | null) => {
    setDraft((previous) => ({ ...previous, [label]: name }));
    setRowErrors((previous) => {
      if (!previous[label]) return previous;
      const { [label]: _dropped, ...rest } = previous;
      return rest;
    });
  };

  /**
   * Who holds each folded name in the current draft, per row label.
   *
   * Ownership is read from the draft rather than the saved rows so that a name
   * can be handed over: clearing one row frees the name immediately, and a row
   * that already owns a name keeps it selectable. A name with more than one
   * claimant (only reachable by typing it twice) stays blocked for a row that
   * is not among the claimants.
   */
  const nameOwners = useMemo(() => {
    const owners = new Map<string, string[]>();
    for (const row of speakers) {
      const folded = personNameKey(draft[row.label] ?? null);
      if (!folded) continue;
      const claimants = owners.get(folded);
      if (claimants) claimants.push(row.label);
      else owners.set(folded, [row.label]);
    }
    return owners;
  }, [speakers, draft]);

  /**
   * Finds the rows a "this person is already assigned to…" error is about.
   *
   * Within one meeting a person holds only one label, so the conflict is a pair
   * of rows whose names are equal ignoring case and surrounding whitespace —
   * including a draft that just copies another row's saved name, which the
   * backend's message names by that row's old speaker number. Only rows whose
   * draft changed in this batch are reported, because they are what the user is
   * looking at; an empty result means the caller falls back to the message.
   */
  const conflictLabels = (): string[] => {
    const names = speakers.map((row) => ({
      label: row.label,
      name: personNameKey(draft[row.label] ?? null),
      changed: (draft[row.label] ?? null) !== (row.speaker_name ?? null),
    }));
    return names
      .filter(
        (row) =>
          row.changed &&
          row.name !== null &&
          names.some((other) => other.label !== row.label && other.name === row.name),
      )
      .map((row) => row.label);
  };

  const handleDone = async () => {
    if (!meetingId) return;

    const assignments: SpeakerAssignment[] = speakers
      .filter((row) => (draft[row.label] ?? null) !== (row.speaker_name ?? null))
      .map((row) => ({ label: row.label, name: draft[row.label] ?? null }));

    if (assignments.length === 0) {
      handleOpenChange(false);
      return;
    }

    setIsSaving(true);
    setRowErrors({});
    setPanelError(null);
    try {
      await invoke<MeetingSpeaker[]>('api_assign_meeting_speakers', {
        meetingId,
        assignments,
      });
      toast.success(i18n.t('speakers.saved'));
      // Close directly: `handleOpenChange` blocks while a save is in flight.
      resetDraft();
      onOpenChange(false);
      // Saving may have created a person, so the next open reads the directory
      // again (and in the meantime the fresh copy is already loaded).
      void loadDirectory();
      // Re-read the paginated transcripts so speaker chips show the new names
      // without a page reload.
      await onRefetchTranscripts?.();
    } catch (error) {
      const message = String(error);
      // The panel stays open so the user can fix the pair the backend rejected.
      const conflicting = conflictLabels();
      if (conflicting.length > 0) {
        setRowErrors(Object.fromEntries(conflicting.map((label) => [label, message])));
        return;
      }
      const conflict = /Speaker (\d+)/.exec(message);
      const label = conflict ? `speaker_${Number(conflict[1]) - 1}` : null;
      if (label && speakers.some((row) => row.label === label)) {
        setRowErrors({ [label]: message });
      } else {
        setPanelError(message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex flex-col gap-4 sm:max-w-md"
        // Keep the transcript readable behind the sheet: the user matches names
        // against the lines. The overlay stays mounted, so an outside click
        // still dismisses the panel and drops the draft.
        overlayClassName="bg-transparent"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {t('speakers.title')}
          </SheetTitle>
          <SheetDescription>
            {t('speakers.description')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {passState && (
            <div
              data-testid="diarization-pass-indicator"
              className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {diarizationStageMessage(passState.stage)}
                {passState.progressPercentage !== null
                  ? ` ${passState.progressPercentage}%`
                  : ''}
              </span>
            </div>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('speakers.loading')}
            </div>
          ) : loadError ? (
            <div className="py-6 text-center text-sm text-red-600">{loadError}</div>
          ) : speakers.length === 0 ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">{DIARIZATION_UNAVAILABLE_HINT}</p>
              <div className="flex justify-center">
                <Button
                  size="sm"
                  data-testid="diarize-meeting-button"
                  onClick={handleDiarize}
                  disabled={isDiarizing || hasDiarizationModel === false || passState !== null}
                  title={
                    hasDiarizationModel === false
                      ? DIARIZATION_UNAVAILABLE_HINT
                      : t('speakers.runTooltip')
                  }
                >
                  {isDiarizing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-4 w-4" />
                  )}
                  {isDiarizing ? t('speakers.running') : t('speakers.run')}
                </Button>
              </div>
              {hasDiarizationModel === null && (
                <p
                  data-testid="diarization-catalog-warning"
                  className="text-xs text-muted-foreground"
                >
                  {t('speakers.catalogWarning')}
                </p>
              )}
              {diarizationReason && (
                <p
                  data-testid="diarization-reason"
                  className="text-sm text-red-600"
                >
                  {diarizationReason}
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-4">
              {speakers.map((row) => (
                <li
                  key={row.label}
                  data-testid={`speaker-row-${row.label}`}
                  className="space-y-1"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{displayLabel(row.label)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('speakers.segmentCount', { count: row.segment_count })}
                    </span>
                  </div>
                  <SpeakerNamePicker
                    label={row.label}
                    value={draft[row.label] ?? null}
                    names={directoryNames}
                    directoryError={directoryError}
                    nameOwners={nameOwners}
                    disabled={isSaving}
                    onValueChange={(name) => setRowValue(row.label, name)}
                  />
                  {rowErrors[row.label] && (
                    <p className="text-xs text-red-600">{rowErrors[row.label]}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {panelError && <p className="text-sm text-red-600">{panelError}</p>}

        <SheetFooter className="gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleDone} disabled={isSaving || isLoading}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('speakers.done')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
