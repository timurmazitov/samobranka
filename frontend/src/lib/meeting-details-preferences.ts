// Meeting-details view preferences (spec: meeting-view-toggle). The chosen
// «Конспект / Транскрипт» tab is remembered globally — one value for all
// meetings — and read back as the initial tab when any meeting opens. The
// key follows the deleted pane-ratio key's dotted namespace; the old ratio
// key is left in place, harmless, with no migration.

export const MEETING_DETAILS_ACTIVE_TAB_KEY = 'samobranka.meetingDetails.activeTab';

export type MeetingDetailsTabPreference = 'summary' | 'transcript';

export function readMeetingDetailsActiveTab(): MeetingDetailsTabPreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(MEETING_DETAILS_ACTIVE_TAB_KEY);
    // Only the two real tabs are honored; anything else falls back to the
    // default like a missing value.
    return value === 'summary' || value === 'transcript' ? value : null;
  } catch {
    return null;
  }
}

export function writeMeetingDetailsActiveTab(tab: MeetingDetailsTabPreference): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MEETING_DETAILS_ACTIVE_TAB_KEY, tab);
  } catch {
    // Preference writes are non-critical; the tab still switches for the session.
  }
}
