// Where a meeting opens: dashed ids get the full meeting page, the intro
// call stays on the home page, anything else uses the legacy notes route.
// Shared by the meeting-list rows and the sidebar's notes-mode button so both
// route a meeting the same way.
export function meetingRoute(meetingId: string): string {
  if (meetingId.startsWith('intro-call')) return '/';
  if (meetingId.includes('-')) return `/meeting-details?id=${meetingId}`;
  return `/notes/${meetingId}`;
}
