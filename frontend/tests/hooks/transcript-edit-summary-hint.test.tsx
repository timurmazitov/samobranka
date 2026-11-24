import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The post-edit hint lives in a small hook page-content wraps around the
// transcript text-save callback. Toasts are captured (Bun shares module mocks
// between files, so the real sonner is restored afterwards).
const originalToast = { ...await import('sonner') };
const infoNotify = mock((..._args: unknown[]) => {});
const successNotify = mock((..._args: unknown[]) => {});
const errorNotify = mock((..._args: unknown[]) => {});
mock.module('sonner', () => ({
  toast: { info: infoNotify, success: successNotify, error: errorNotify, warning: infoNotify },
}));
afterAll(() => {
  mock.module('sonner', () => originalToast);
});
afterEach(() => {
  infoNotify.mockClear();
  successNotify.mockClear();
  errorNotify.mockClear();
});

// Same pattern as the transcript row suite: importing the catalog initializes
// i18next (English default), so the hook's t() calls resolve real strings.
await import('../../src/i18n');
const { useTranscriptEditSummaryHint } = await import(
  '../../src/hooks/meeting-details/useTranscriptEditSummaryHint'
);

type Hint = () => void;
let notify: Hint;
function Harness(props: { hasCompletedSummary: boolean; onRegenerate: () => void | Promise<void> }) {
  notify = useTranscriptEditSummaryHint(props);
  return null;
}

let renderer: ReactTestRenderer | undefined;
async function render(props: { hasCompletedSummary: boolean; onRegenerate: () => void | Promise<void> }) {
  await act(async () => {
    if (renderer) renderer.update(<Harness {...props} />);
    else renderer = create(<Harness {...props} />);
  });
}

describe('regenerate-summary hint after a transcript text edit', () => {
  test('a saved edit with a completed summary shows one action toast that regenerates', async () => {
    const regenerate = mock(async () => {});
    await render({ hasCompletedSummary: true, onRegenerate: regenerate });

    await act(async () => { notify(); });

    expect(infoNotify).toHaveBeenCalledTimes(1);
    const [message, options] = infoNotify.mock.calls[0] as [string, Record<string, any>];
    // Strings come from the English catalog: the stale-summary message and the
    // same label the summary panel's regenerate button already uses.
    expect(message).toBe('The summary no longer matches your edited transcript.');
    expect(options.action.label).toBe('Regenerate Summary');
    // The hint never regenerates on its own.
    expect(regenerate).not.toHaveBeenCalled();

    await act(async () => { options.action.onClick(); });
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  test('a saved edit with no summary shows no hint', async () => {
    const regenerate = mock(async () => {});
    await render({ hasCompletedSummary: false, onRegenerate: regenerate });

    await act(async () => { notify(); });

    expect(infoNotify).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  test('consecutive edits refresh a single hint instead of stacking copies', async () => {
    const regenerate = mock(async () => {});
    await render({ hasCompletedSummary: true, onRegenerate: regenerate });

    await act(async () => { notify(); });
    await act(async () => { notify(); });

    expect(infoNotify).toHaveBeenCalledTimes(2);
    const first = infoNotify.mock.calls[0][1] as Record<string, unknown>;
    const second = infoNotify.mock.calls[1][1] as Record<string, unknown>;
    // Sonner replaces (never stacks) toasts sharing an id, so the shared id is
    // what keeps one current hint on screen.
    expect(typeof first.id).toBe('string');
    expect(second.id).toBe(first.id);
  });
});
