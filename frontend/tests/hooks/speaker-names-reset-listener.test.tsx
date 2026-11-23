import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import en from '../../src/i18n/locales/en/translation.json';

const originalToast = { ...await import('sonner') };
afterAll(() => {
  mock.module('sonner', () => originalToast);
});

const notify = mock(() => {});
mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));

const { useSpeakerNamesResetListener } = await import('../../src/hooks/useSpeakerNamesResetListener');

type Handler = (event: { payload: Record<string, unknown> }) => void;

/** Fake native event bridge, injected through the hook's seam. */
function fakeListen() {
  const registered = new Map<string, Handler>();
  const unlistened = mock((name: string) => {});
  const listen = async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
      unlistened(name);
    };
  };
  return { registered, unlistened, listen };
}

let renderer: ReactTestRenderer | undefined;
let refetches = 0;
let bridge = fakeListen();

function Harness({ meetingId }: { meetingId: string }) {
  useSpeakerNamesResetListener(meetingId, () => { refetches += 1; }, bridge.listen);
  return <span>{meetingId}</span>;
}

function HarnessWithBridge({ meetingId, listenImpl }: { meetingId: string; listenImpl: any }) {
  useSpeakerNamesResetListener(meetingId, () => { refetches += 1; }, listenImpl);
  return <span>{meetingId}</span>;
}

async function show(meetingId = 'meeting-a') {
  await act(async () => { renderer = create(<Harness meetingId={meetingId} />); });
}

async function emit(payload: Record<string, unknown>) {
  const handler = bridge.registered.get('speaker-names-reset');
  expect(handler).toBeDefined();
  await act(async () => { handler!({ payload }); });
}

afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  bridge = fakeListen();
  notify.mockClear();
  refetches = 0;
});

test('the reset hint is shown and the transcript refetched for the open meeting', async () => {
  await show('meeting-a');

  // D7 wire format: the code resolves the localized sentence; the prose
  // field stays as the diagnostic fallback for a code this build is newer
  // than (an unknown code falls through to it, then to the generic key).
  await emit({ meeting_id: 'meeting-a', code: 'reset', message: 'Names went away.' });

  expect(notify).toHaveBeenCalledTimes(1);
  const [title, options] = notify.mock.calls[0] as unknown as [string, { description?: string }];
  expect(title).toBe('Speaker names were reset');
  expect(options.description).toBe(en.speakers.failures.reset);
  expect(refetches).toBe(1);
});

test('the hint falls back to the shared text when the payload has no message', async () => {
  await show('meeting-a');

  await emit({ meeting_id: 'meeting-a' });

  const [title, options] = notify.mock.calls[0] as unknown as [string, { description?: string }];
  expect(title).toBe('Speaker names were reset');
  // Never empty: no code and no prose still renders the catalog sentence.
  expect(options.description).toBe(en.speakers.failures.reset);
});

test('a code this build does not know still renders the prose it was given', async () => {
  await show('meeting-a');

  await emit({ meeting_id: 'meeting-a', code: 'from_the_future', message: 'Native explains itself' });

  const [, options] = notify.mock.calls[0] as unknown as [string, { description?: string }];
  expect(options.description).toBe('Native explains itself');
});

test('the hint for another meeting is ignored', async () => {
  await show('meeting-a');

  await emit({ meeting_id: 'meeting-b', message: 'Not yours.' });

  expect(notify).not.toHaveBeenCalled();
  expect(refetches).toBe(0);
});

test('an import event without a meeting id matches the open meeting', async () => {
  await show('meeting-a');

  await emit({ message: 'Imported names.' });

  expect(notify).toHaveBeenCalledTimes(1);
  expect(refetches).toBe(1);
});

test('a missing event bridge does not break the page', async () => {
  const failure = async () => { throw new Error('no bridge'); };
  await act(async () => {
    renderer = create(
      <HarnessWithBridge meetingId="meeting-a" listenImpl={failure as any} />,
    );
  });

  expect(notify).not.toHaveBeenCalled();
  expect(refetches).toBe(0);
});

test('the listener is removed on unmount', async () => {
  await show('meeting-a');
  expect(bridge.registered.has('speaker-names-reset')).toBe(true);

  await act(async () => { renderer!.unmount(); });
  renderer = undefined;

  expect(bridge.registered.has('speaker-names-reset')).toBe(false);
  expect(bridge.unlistened).toHaveBeenCalledWith('speaker-names-reset');
});
