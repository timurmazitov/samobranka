/**
 * The retranscription dialog's listener for `diarization-unavailable`.
 *
 * Retranscription commits the new transcript and writes the files before the
 * diarization pass runs, and native code emits this event only when the pass
 * failed. The dialog checks the payload status anyway: a configuration reason
 * must stay silent, because the user never asked for the pass.
 *
 * Radix Dialog and Select do not render without a DOM, so they are replaced
 * with plain containers; the Tauri and sonner modules are mocked with an
 * `afterAll` restore that spreads the real module.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import en from '../../src/i18n/locales/en/translation.json';

const modules = [
  '../../src/components/ui/dialog',
  '../../src/components/ui/select',
  '../../src/contexts/ConfigContext',
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  'sonner',
];
const originals = await Promise.all(
  modules.map(async path => [path, { ...(await import(path)) }] as const),
);
afterAll(() => {
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

const Container = ({ children }: any) => <div>{children}</div>;

mock.module('../../src/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: Container,
  DialogDescription: Container,
  DialogFooter: Container,
  DialogHeader: Container,
  DialogTitle: Container,
  DialogTrigger: Container,
  DialogClose: Container,
  DialogPortal: Container,
  DialogOverlay: Container,
}));

mock.module('../../src/components/ui/select', () => ({
  Select: Container,
  SelectContent: Container,
  SelectItem: Container,
  SelectTrigger: Container,
  SelectValue: Container,
  SelectGroup: Container,
  SelectLabel: Container,
  SelectSeparator: Container,
}));

mock.module('../../src/contexts/ConfigContext', () => ({
  useConfig: () => ({
    selectedLanguage: 'auto',
    transcriptModelConfig: { provider: 'transcribeCpp', model: 'parakeet-ultra-Q8_0' },
  }),
}));

type Handler = (event: { payload: Record<string, unknown> }) => void;
const registered = new Map<string, Handler>();

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'transcribecpp_get_available_models') return [];
    return undefined;
  },
}));

mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  },
}));

const toastError = mock(() => {});
const toastInfo = mock(() => {});
const toastSuccess = mock(() => {});
const toastWarning = mock(() => {});

mock.module('sonner', () => ({
  toast: {
    info: toastInfo,
    error: toastError,
    success: toastSuccess,
    warning: toastWarning,
  },
}));

const { RetranscribeDialog } = await import(
  '../../src/components/MeetingDetails/RetranscribeDialog'
);

let renderer: ReactTestRenderer | undefined;

async function show(meetingId = 'meeting-a') {
  await act(async () => {
    renderer = create(
      <RetranscribeDialog
        open
        onOpenChange={() => {}}
        meetingId={meetingId}
        meetingFolderPath="/tmp/meeting-a"
      />,
    );
  });
  for (let attempt = 0; attempt < 50 && !registered.has('diarization-unavailable'); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function emitDiarizationUnavailable(payload: Record<string, unknown>) {
  const handler = registered.get('diarization-unavailable');
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload });
  });
}

beforeEach(() => {
  registered.clear();
  toastError.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer!.unmount();
    });
  }
  renderer = undefined;
});

test('a failed pass is reported for the meeting being retranscribed', async () => {
  await show('meeting-a');

  await emitDiarizationUnavailable({
    meeting_id: 'meeting-a',
    status: 'failed',
    reason: 'engine exploded',
    // D7 wire format: the code drives the UI; the prose field stays as the
    // diagnostic fallback an older frontend build would render.
    code: 'failed',
    message: 'native diagnostic prose',
  });

  expect(toastError).toHaveBeenCalledTimes(1);
  const [title, options] = toastError.mock.calls[0] as unknown as [
    string,
    { description?: string },
  ];
  expect(title).toBe('Diarization failed');
  expect(options.description).toBe(en.speakers.failures.failed);
});

test('configuration reasons stay silent: the user did not request the pass', async () => {
  await show('meeting-a');

  for (const status of ['no_model', 'no_runtime', 'deferred', 'ran']) {
    await emitDiarizationUnavailable({ meeting_id: 'meeting-a', status });
  }

  expect(toastError).not.toHaveBeenCalled();
  expect(toastInfo).not.toHaveBeenCalled();
});

test('a failed pass for another meeting is ignored', async () => {
  await show('meeting-a');

  await emitDiarizationUnavailable({
    meeting_id: 'meeting-b',
    status: 'failed',
    // D7 wire format: the code drives the UI; the prose field stays as the
    // diagnostic fallback an older frontend build would render.
    code: 'failed',
    message: 'native diagnostic prose',
  });

  expect(toastError).not.toHaveBeenCalled();
});
