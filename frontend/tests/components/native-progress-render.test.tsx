/**
 * The import and retranscription dialogs render the coded progress payloads
 * in the UI language, falling back to the English `message` when the code is
 * unknown or absent (native-i18n spec D7, ticket 06).
 *
 * The resolver logic itself is pinned in `tests/lib/native-progress.test.ts`;
 * these are the wiring checks: the dialogs must actually consult it, in both
 * bar caption and description slots, and keep the prose fallback alive.
 *
 * Scaffolding mirrors the two diarization suites: Radix pieces and the model/
 * config hooks are replaced with containers and fakes, and the Tauri/sonner
 * modules are mocked with an `afterAll` restore that spreads the real module.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import i18n from '../../src/i18n';

const modules = [
  '../../src/components/ui/dialog',
  '../../src/components/ui/select',
  '../../src/contexts/ConfigContext',
  '../../src/hooks/useTranscriptionModels',
  '../../src/components/Sidebar/SidebarProvider',
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  'next/navigation',
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
    transcriptModelConfig: { provider: 'transcribeCpp', model: 'parakeet-ultra-Q8_0' },
  }),
}));

mock.module('../../src/hooks/useTranscriptionModels', () => ({
  useTranscriptionModels: () => ({
    availableModels: [],
    selectedModelKey: null,
    setSelectedModelKey: () => {},
    loadingModels: false,
    fetchModels: () => {},
    resetSelection: () => {},
  }),
}));

mock.module('../../src/components/Sidebar/SidebarProvider', () => ({
  useSidebar: () => ({ refetchMeetings: () => {} }),
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

const FILE_INFO = {
  path: '/tmp/a.wav',
  filename: 'a',
  duration_seconds: 1,
  size_bytes: 1,
  format: 'WAV',
};

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'validate_audio_file_command') return FILE_INFO;
    return undefined;
  },
}));

type Handler = (event: { payload: Record<string, unknown> }) => void;
const registered = new Map<string, Handler>();
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  },
}));

mock.module('sonner', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {}, warning: () => {} },
}));

const { ImportAudioDialog } = await import('../../src/components/ImportAudio/ImportAudioDialog');
const { RetranscribeDialog } = await import(
  '../../src/components/MeetingDetails/RetranscribeDialog'
);

let renderer: ReactTestRenderer | undefined;

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON() ?? null);
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function findButton(label: string): { onClick: () => void } | undefined {
  const tree = renderer?.toJSON();
  const out: Array<{ label: string; onClick: () => void }> = [];
  const walk = (node: any) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.type === 'button') {
      const text = JSON.stringify(node.children ?? []).replace(/[^A-Za-z ]/g, '');
      out.push({ label: text, onClick: node.props?.onClick ?? (() => {}) });
    }
    if (node.children) walk(node.children);
  };
  walk(tree);
  return out.find((button) => button.label.includes(label));
}

async function emitTauri(name: string, payload: Record<string, unknown>) {
  const handler = registered.get(name);
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload });
  });
  await flush();
}

async function waitRegistered(name: string) {
  for (let attempt = 0; attempt < 60 && !registered.has(name); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  expect(registered.has(name)).toBe(true);
}

beforeEach(async () => {
  registered.clear();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer!.unmount();
    });
  }
  renderer = undefined;
  await i18n.changeLanguage('en');
});

describe('ImportAudioDialog progress', () => {
  async function openImportDialog() {
    await act(async () => {
      renderer = create(
        <ImportAudioDialog open onOpenChange={() => {}} preselectedFile="/tmp/a.wav" />,
      );
    });
    await waitRegistered('import-error');
    const button = findButton('Import');
    expect(button).toBeDefined();
    await act(async () => {
      button!.onClick();
    });
    await flush();
  }

  test('a coded phase renders the catalog sentence, not the raw message', async () => {
    await openImportDialog();
    await emitTauri('import-progress', {
      stage: 'decoding',
      progress_percentage: 15,
      message: 'RAW-NATIVE-PROSE',
      code: 'decoding_file',
    });
    expect(renderedText()).toContain('Decoding audio file...');
    expect(renderedText()).not.toContain('RAW-NATIVE-PROSE');
  });

  test('the stage caption reads as a word, not the snake_case token', async () => {
    await openImportDialog();
    await emitTauri('import-progress', {
      stage: 'resampling',
      progress_percentage: 22,
      message: 'Resampling audio: 50%',
      code: 'resampling_percent',
      params: { percent: 50 },
    });
    expect(renderedText()).toContain('Converting');
    expect(renderedText()).toContain('Resampling audio: 50%');
  });

  test('an unknown code falls back to the English message, never blank', async () => {
    await openImportDialog();
    await emitTauri('import-progress', {
      stage: 'transcribing',
      progress_percentage: 40,
      message: 'FUTURE-NATIVE-PROSE',
      code: 'exploding_audio',
    });
    expect(renderedText()).toContain('FUTURE-NATIVE-PROSE');
  });

  test('a coded segment line renders in Russian with the locale decimal separator', async () => {
    // Open and start while the buttons are still English (the harness finds
    // them by label), then switch: the dialog re-renders through the hook's
    // useTranslation subscription, which is the moment the language matters.
    await openImportDialog();
    await i18n.changeLanguage('ru');
    await flush();
    await emitTauri('import-progress', {
      stage: 'transcribing',
      progress_percentage: 40,
      message: 'Transcribing segment 2 of 5 (1.2s)...',
      code: 'transcribing_segment',
      params: { current: 2, total: 5, duration_sec: 1.2 },
    });
    expect(renderedText()).toContain('Транскрибация: сегмент 2 из 5 (1,2 с)…');
  });
});

describe('RetranscribeDialog progress', () => {
  async function openRetranscribeDialog() {
    await act(async () => {
      renderer = create(
        <RetranscribeDialog
          open
          onOpenChange={() => {}}
          meetingId="meeting-a"
          meetingFolderPath="/tmp/meeting-a"
          invokeImpl={async () => undefined}
        />,
      );
    });
    await waitRegistered('retranscription-progress');
    const button = findButton('Start Retranscription');
    expect(button).toBeDefined();
    await act(async () => {
      button!.onClick();
    });
    await flush();
  }

  test('a coded phase renders the catalog sentence, not the raw message', async () => {
    await openRetranscribeDialog();
    await emitTauri('retranscription-progress', {
      meeting_id: 'meeting-a',
      stage: 'saving',
      progress_percentage: 70,
      message: 'RAW-NATIVE-PROSE',
      code: 'saving_transcripts',
    });
    expect(renderedText()).toContain('Saving transcripts...');
    expect(renderedText()).not.toContain('RAW-NATIVE-PROSE');
  });

  test('the stage caption localizes the native token', async () => {
    await openRetranscribeDialog();
    await emitTauri('retranscription-progress', {
      meeting_id: 'meeting-a',
      stage: 'vad',
      progress_percentage: 22,
      message: 'Detecting speech segments... 40% (3 found)',
      code: 'detecting_segments_progress',
      params: { percent: 40, found: 3 },
    });
    expect(renderedText()).toContain('Detecting speech');
    expect(renderedText()).toContain('Detecting speech segments... 40% (3 found)');
  });

  test('an unknown code falls back to the English message, never blank', async () => {
    await openRetranscribeDialog();
    await emitTauri('retranscription-progress', {
      meeting_id: 'meeting-a',
      stage: 'transcribing',
      progress_percentage: 40,
      message: 'FUTURE-NATIVE-PROSE',
      code: 'exploding_audio',
    });
    expect(renderedText()).toContain('FUTURE-NATIVE-PROSE');
  });

  test('an unseen stage token stays raw rather than going blank', async () => {
    await openRetranscribeDialog();
    await emitTauri('retranscription-progress', {
      meeting_id: 'meeting-a',
      stage: 'quantum_leap',
      progress_percentage: 40,
      message: 'Quantum leaping...',
    });
    expect(renderedText()).toContain('quantum_leap');
  });

  test('a coded segment line renders in Russian with the locale decimal separator', async () => {
    // Same as the import case: start while the buttons are English, switch
    // before the emit so the render happens in Russian.
    await openRetranscribeDialog();
    await i18n.changeLanguage('ru');
    await flush();
    await emitTauri('retranscription-progress', {
      meeting_id: 'meeting-a',
      stage: 'transcribing',
      progress_percentage: 40,
      message: 'Transcribing segment 2 of 5 (1.2s)...',
      code: 'transcribing_segment',
      params: { current: 2, total: 5, duration_sec: 1.2 },
    });
    expect(renderedText()).toContain('Транскрибация: сегмент 2 из 5 (1,2 с)…');
  });
});
