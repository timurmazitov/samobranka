/**
 * Rust-emitted progress codes must have catalog keys (native-i18n spec D7).
 *
 * The frontend builds the key dynamically (`importAudio.progress.${code}`),
 * which the `i18n-usage` guard exempts by design, so this test is the pin:
 * every `CODE_*` constant in the three emitting Rust modules must resolve to
 * a non-empty string in BOTH locales, either under the module's progress
 * namespace or through the `complete` stage-key reuse (the resolvers in
 * `lib/native-progress.ts` are the source of that mapping). It also pins the
 * stage-caption vocabulary the native `stage` tokens hit.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

const RUST_ROOT = '../../src-tauri/src/audio';

/** `const CODE_[A-Z_]+: &str = "value";` → every value in the file. */
function rustCodes(source: string): string[] {
  return [...source.matchAll(/const CODE_[A-Z_]+: &str = "([a-z_]+)";/g)].map((m) => m[1]);
}

function readRust(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

type Catalog = Record<string, unknown>;

function lookup(catalog: Catalog, path: string): string | null {
  let node: unknown = catalog;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Catalog)[part];
  }
  return typeof node === 'string' && node.trim() ? node : null;
}

/** True when `base` exists as a leaf string or carries a plural family. */
function hasProgressKey(catalog: Catalog, base: string): boolean {
  if (lookup(catalog, base) !== null) return true;
  const leaf = base.slice(base.lastIndexOf('.') + 1);
  const parentPath = base.slice(0, base.lastIndexOf('.'));
  let parent: unknown = catalog;
  for (const part of parentPath.split('.')) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Catalog)[part];
  }
  if (parent === null || typeof parent !== 'object') return false;
  return Object.keys(parent as Catalog).some((key) => key.startsWith(`${leaf}_`));
}

// The mapping `lib/native-progress.ts` implements; duplicated here on purpose
// so a drift between the resolver and the catalogs is a test failure, not a
// silently English (or raw-key) caption.
const PROGRESS_BASE: Record<string, string> = {
  import: 'importAudio.progress',
  retranscribe: 'retranscribe.progress',
};
const REUSED: Record<string, Record<string, string>> = {
  import: { complete: 'importAudio.stages.complete' },
  retranscribe: { complete: 'retranscribe.stages.complete' },
};

function expectCodesResolved(module: 'import' | 'retranscribe', codes: string[]): void {
  expect(codes.length).toBeGreaterThan(0);
  for (const locale of ['en', 'ru'] as const) {
    const catalog = locale === 'en' ? en : (ru as Catalog);
    for (const code of codes) {
      const reused = REUSED[module][code];
      if (reused) {
        expect(lookup(catalog, reused), `${module} ${locale}: ${code} -> ${reused}`).not.toBeNull();
        continue;
      }
      const key = `${PROGRESS_BASE[module]}.${code}`;
      expect(
        hasProgressKey(catalog, key),
        `${module} ${locale}: missing catalog key ${key}`,
      ).toBe(true);
    }
  }
}

describe('import progress codes', () => {
  const codes = rustCodes(readRust(`${RUST_ROOT}/import.rs`));

  test('every CODE_* in import.rs resolves in both locales', () => {
    expectCodesResolved('import', codes);
  });

  test('the decoder-forwarded codes resolve too', () => {
    // The decoder only feeds the import bar, so its codes land under
    // importAudio.progress as well.
    expectCodesResolved('import', rustCodes(readRust(`${RUST_ROOT}/decoder.rs`)));
  });
});

describe('retranscription progress codes', () => {
  test('every CODE_* in retranscription.rs resolves in both locales', () => {
    expectCodesResolved('retranscribe', rustCodes(readRust(`${RUST_ROOT}/retranscription.rs`)));
  });
});

describe('stage captions', () => {
  // The stage tokens the native emitters put on the payload, plus the two
  // frontend-synthetic stages the bars enter during diarization/completion.
  const IMPORT_STAGES = ['copying', 'decoding', 'resampling', 'vad', 'transcribing', 'saving', 'diarizing', 'complete'];
  const RETRANSCRIPTION_STAGES = ['decoding', 'vad', 'transcribing', 'saving', 'diarizing', 'complete'];

  test('the import bar has a word for every stage it can receive', () => {
    for (const locale of ['en', 'ru'] as const) {
      const catalog = locale === 'en' ? en : (ru as Catalog);
      for (const stage of IMPORT_STAGES) {
        expect(lookup(catalog, `importAudio.stages.${stage}`), `${locale}: importAudio.stages.${stage}`).not.toBeNull();
      }
    }
  });

  test('the retranscription bar has a word for every stage it can receive', () => {
    for (const locale of ['en', 'ru'] as const) {
      const catalog = locale === 'en' ? en : (ru as Catalog);
      for (const stage of RETRANSCRIPTION_STAGES) {
        expect(lookup(catalog, `retranscribe.stages.${stage}`), `${locale}: retranscribe.stages.${stage}`).not.toBeNull();
      }
    }
  });
});
