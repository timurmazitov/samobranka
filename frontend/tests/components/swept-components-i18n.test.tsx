/**
 * Ticket 04 sweep: components that were never translated must render their
 * labels from the catalogs instead of English literals.
 *
 * Expected strings are read from the catalog JSON (so the test breaks when
 * code and catalogs disagree) and rendering runs in both languages: in `ru`
 * the English literal must be gone. Tauri, sonner, framer-motion and the
 * Radix wrappers are mocked with plain containers, matching the other
 * component suites; like those suites, the `sonner` and `framer-motion`
 * mocks stay installed for the process instead of being restored.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const Container = ({ children }: any) => <div>{children}</div>;
const motionContainer = (props: any) => <div>{props.children}</div>;

const originals = await Promise.all(
  [
    '../../src/components/ui/tooltip',
    '../../src/components/ui/dialog',
    '../../src/components/ui/select',
    '../../src/components/ui/dropdown-menu',
    '../../src/components/ui/tabs',
    '../../src/contexts/ConfigContext',
    '../../src/hooks/useTranscriptionModels',
    '../../src/components/RecordingStatusBar',
    '@tauri-apps/api/core',
    '@tauri-apps/api/event',
  ].map(async path => [path, { ...(await import(path)) }] as const),
);
const [
  originalTooltip,
  originalDialog,
  originalSelect,
  originalDropdown,
  originalTabs,
  originalConfig,
  originalModelsHook,
  originalStatusBar,
  originalCore,
  originalEvent,
] = originals.map(([, mod]) => mod);

afterAll(() => {
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

/**
 * Registered in `beforeEach`, not at the top level: bun installs every
 * file's mocks before running any test, so a top-level registration of a
 * module another suite needs for real (the config context, the model hook)
 * would leak into those suites. Re-registering per test keeps this file's
 * fakes authoritative for its own tests.
 */
function applyComponentMocks() {
  mock.module('../../src/components/ui/tooltip', () => ({
    Tooltip: Container,
    TooltipTrigger: Container,
    TooltipContent: Container,
    TooltipProvider: Container,
  }));
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
    SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
    SelectGroup: Container,
    SelectLabel: Container,
    SelectSeparator: Container,
  }));
  mock.module('../../src/components/ui/dropdown-menu', () => ({
    DropdownMenu: Container,
    DropdownMenuTrigger: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: Container,
    DropdownMenuLabel: Container,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuGroup: Container,
  }));
  mock.module('../../src/components/ui/tabs', () => ({
    Tabs: Container,
    TabsContent: Container,
    TabsList: Container,
    TabsTrigger: Container,
  }));
  mock.module('../../src/contexts/ConfigContext', () => ({
    ...originalConfig,
    useConfig: () => ({
      selectedLanguage: 'auto',
      transcriptModelConfig: { provider: 'transcribeCpp' },
    }),
  }));
  mock.module('../../src/hooks/useTranscriptionModels', () => ({
    ...originalModelsHook,
    useTranscriptionModels: () => ({
      availableModels: [],
      selectedModelKey: null,
      setSelectedModelKey: () => {},
      loadingModels: false,
      fetchModels: () => {},
      resetSelection: () => {},
    }),
  }));
  mock.module('../../src/components/RecordingStatusBar', () => ({
    RecordingStatusBar: Container,
  }));
  mock.module('@tauri-apps/api/core', () => ({
    ...originalCore,
    invoke: async () => ({}),
  }));
  mock.module('@tauri-apps/api/event', () => ({
    ...originalEvent,
    listen: async () => () => {},
    emit: async () => {},
  }));
}

// The split view reads window.matchMedia; the transcript views read
// localStorage and listen for the speech-detected event. A minimal shim is
// enough for these renders. The previous value is restored afterwards.
const globalWithWindow = globalThis as unknown as { window?: unknown };
const previousWindow = globalWithWindow.window;
globalWithWindow.window = {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
};

mock.module('sonner', () => ({
  toast: Object.assign(() => {}, {
    success: () => {},
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
}));
// Not restored: same reason as the other component suites — an `afterAll`
// restore would replace the real module for suites that keep the mock.
mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => motionContainer }),
  AnimatePresence: Container,
}));

const { default: i18n } = await import('../../src/i18n');
const en = (await import('../../src/i18n/locales/en/translation.json')).default;
const ru = (await import('../../src/i18n/locales/ru/translation.json')).default;

function lookup(catalog: any, key: string): string {
  const value = key.split('.').reduce((acc: any, part) => acc?.[part], catalog);
  if (typeof value !== 'string') {
    throw new Error(`catalog key ${key} is missing`);
  }
  return value;
}

beforeEach(() => {
  applyComponentMocks();
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => { await i18n.changeLanguage('en'); });
});
afterAll(() => {
  if (previousWindow === undefined) delete globalWithWindow.window;
  else globalWithWindow.window = previousWindow;
});

function text(view: ReactTestRenderer): string {
  return JSON.stringify(view.toJSON());
}

async function render(element: React.ReactElement): Promise<string> {
  await act(async () => {
    renderer = create(element);
  });
  return text(renderer!);
}

/** Renders `element` in both languages and asserts catalog-driven labels. */
async function expectTranslated(
  element: () => React.ReactElement,
  keys: string[],
  englishLiterals: string[] = [],
) {
  await act(async () => { await i18n.changeLanguage('en'); });
  const enText = await render(element());
  for (const key of keys) {
    expect(enText).toContain(lookup(en, key));
  }

  await act(async () => { await i18n.changeLanguage('ru'); });
  const ruText = await render(element());
  for (const key of keys) {
    expect(ruText).toContain(lookup(ru, key));
  }
  for (const literal of englishLiterals) {
    expect(ruText).not.toContain(literal);
  }
}

const { EmptyStateSummary } = await import('../../src/components/EmptyStateSummary');

describe('EmptyStateSummary', () => {
  const element = () => (
    <EmptyStateSummary hasModel={false} onGenerate={() => {}} />
  );

  test('renders the empty state from the catalogs', async () => {
    await expectTranslated(
      element,
      [
        'summary.emptyState.title',
        'summary.emptyState.description',
        'summary.emptyState.generate',
        'summary.emptyState.selectModelHint',
      ],
      [
        'No Summary Generated Yet',
        'Generate Summary',
        'Please select a model in Settings first',
      ],
    );
  });
});

const { ConfidenceIndicator } = await import('../../src/components/ConfidenceIndicator');

describe('ConfidenceIndicator', () => {
  const element = () => <ConfidenceIndicator confidence={0.45} />;

  test('labels the indicator from the catalogs with the percentage', async () => {
    for (const lang of ['en', 'ru'] as const) {
      const catalog = lang === 'en' ? en : ru;
      const label = lookup(catalog, 'confidence.medium');
      await act(async () => { await i18n.changeLanguage(lang); });
      const rendered = await render(element());
      expect(rendered).toContain(
        lookup(catalog, 'confidence.aria').replace('{{percent}}', '45'),
      );
      expect(rendered).toContain(
        lookup(catalog, 'confidence.title')
          .replace('{{percent}}', '45')
          .replace('{{label}}', label),
      );
      expect(rendered).toContain(label);
    }
    await act(async () => { await i18n.changeLanguage('ru'); });
    expect(await render(element())).not.toContain('Medium confidence');
  });
});

const { SummaryUpdaterButtonGroup } = await import(
  '../../src/components/MeetingDetails/SummaryUpdaterButtonGroup'
);

describe('SummaryUpdaterButtonGroup', () => {
  const element = () => (
    <SummaryUpdaterButtonGroup
      onCopy={async () => {}}
      onExport={async () => {}}
    />
  );

  test('labels the export menu from the catalogs', async () => {
    await expectTranslated(
      element,
      [
        'summary.updater.export',
        'summary.updater.exportTitle',
        'common.copyToClipboard',
        'common.exportAsMarkdown',
      ],
      ['Copy Summary', 'Export Summary'],
    );
  });
});

const { RetranscribeDialog } = await import(
  '../../src/components/MeetingDetails/RetranscribeDialog'
);

describe('RetranscribeDialog', () => {
  const element = () => (
    <RetranscribeDialog
      open
      onOpenChange={() => {}}
      meetingId="m1"
      meetingFolderPath="/tmp/m1"
    />
  );

  test('renders the idle dialog from the catalogs', async () => {
    await expectTranslated(
      element,
      [
        'retranscribe.title',
        'retranscribe.languageLabel',
        'retranscribe.languageTranscribeCppHint',
        'retranscribe.start',
        'common.cancel',
      ],
      ['Retranscribe Meeting', 'Start Retranscription'],
    );
  });
});

const { MeetingDetailsSplitView } = await import(
  '../../src/components/MeetingDetails/MeetingDetailsSplitView'
);

describe('MeetingDetailsSplitView', () => {
  const element = () => (
    <MeetingDetailsSplitView
      transcript={<div>t</div>}
      summary={<div>s</div>}
      activeTab="transcript"
      onTabChange={() => {}}
    />
  );

  test('names the tabs from the catalogs', async () => {
    await expectTranslated(
      element,
      ['meetingDetails.split.tabTranscript', 'meetingDetails.split.tabSummary'],
      ['Transcript', 'Summary'],
    );
  });
});

const { VirtualizedTranscriptView } = await import(
  '../../src/components/VirtualizedTranscriptView'
);

describe('VirtualizedTranscriptView', () => {
  const element = () => (
    <VirtualizedTranscriptView segments={[]} />
  );

  test('renders the idle empty state from the catalogs', async () => {
    await expectTranslated(
      element,
      ['transcript.welcomeTitle', 'transcript.welcomeHint'],
      ['Start recording to see live transcription'],
    );
  });

  test('the speaker chip title comes from the catalog', async () => {
    const withRows = () => (
      <VirtualizedTranscriptView
        segments={[
          {
            id: '1',
            timestamp: 0,
            text: 'hello',
            speaker: 'speaker_0',
            speaker_name: 'Alex',
          } as never,
        ]}
      />
    );
    await act(async () => { await i18n.changeLanguage('ru'); });
    const ruText = await render(withRows());
    expect(ruText).toContain(
      lookup(ru, 'transcript.speakerAttributedDiarization').replace('{{speaker}}', 'speaker_0'),
    );
    expect(ruText).not.toContain('Speaker attributed by diarization');
  });
});
