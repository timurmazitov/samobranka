import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

/**
 * Usage-vs-catalog guard plus English-literal-bypass guard.
 *
 * Two jobs:
 *
 * 1. Usage vs catalog. The parity test compares `en` against `ru` and cannot
 *    see a key that code calls but NEITHER catalog defines — i18next then
 *    silently renders the raw key path (`speakers.title` on screen). This test
 *    scans the sources for literal `t('a.b')` / `i18n.t('a.b')` key strings
 *    and requires every one of them to exist in both catalogs.
 *
 *    Keys built at runtime (template literals, variables, ternaries mixing
 *    both) are exempt: the guard validates every string literal it can find in
 *    the first argument — a ternary of two literals is checked on both halves.
 *
 * 2. Bypass vs catalogs (native-i18n ticket 09). Job 1 only checks keys that
 *    are already routed through `t()`, so an English literal that never
 *    reaches `t()` was invisible: the microphone toasts in
 *    `RecordingStateContext.tsx` and English `title=` labels shipped in
 *    Russian for months because no shape below existed here. The scans cover
 *    the shapes user-visible strings travel through: the first argument of a
 *    toast helper, `title=` JSX attributes, and `statusMessage` property
 *    assignments.
 *
 * A literal counts as untranslated English UI prose when it reads like
 * words, not as a catalog key, a Tailwind class list, or a technical
 * fragment: see `isProseLiteral`. An `i18n-usage-allow` marker on the same
 * line exempts a deliberate literal (brand text, protocol strings); prefer a
 * catalog key and keep the exemption list short.
 */

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'] as const;

/**
 * Whether `key` exists in `catalog`: as a leaf value, or as the base of a
 * plural family (`allDone` matches `allDone_one/_few/_many/...`, the way
 * i18next resolves `t(key, { count })`).
 */
function catalogHas(catalog: unknown, key: string): boolean {
  const parts = key.split('.');
  const leaf = parts[parts.length - 1];
  let parent: unknown = catalog;
  for (const part of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return false;
    parent = (parent as Record<string, unknown>)[part];
  }
  if (parent === null || typeof parent !== 'object') return false;
  const entries = parent as Record<string, unknown>;
  const present = (value: unknown) =>
    typeof value === 'string'
    || (value !== null && typeof value === 'object' && Object.keys(value).length > 0);
  return present(entries[leaf])
    || PLURAL_SUFFIXES.some(suffix => present(entries[`${leaf}${suffix}`]));
}

/**
 * Blanks comment bodies (outside string literals) so commented-out `t()`
 * examples cannot produce false positives. Comments are replaced by spaces to
 * keep offsets and line counts stable. Lines carrying an `i18n-usage-allow`
 * marker are left intact: the marker is read from them (blanking first would
 * erase the exemption with the comment that states it).
 */
function stripComments(source: string): string {
  const MARKER = 'i18n-usage-allow';
  const out = source.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let keepLine = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    const next = out[i + 1];
    if (ch === '\n') keepLine = false;
    if (keepLine) continue;
    if (!state.startsWith('sing') && state !== 'double' && state !== 'template'
      && source.startsWith(MARKER, i)) {
      keepLine = true;
      continue;
    }
    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i++; }
        else if (ch === '/' && next === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i++; }
        else if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        break;
      case 'line':
        if (ch === '\n') state = 'code'; else out[i] = ' ';
        break;
      case 'block':
        if (ch === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
        else if (ch !== '\n') out[i] = ' ';
        break;
      case 'single':
        if (ch === '\\') i++; else if (ch === "'" || ch === '\n') state = 'code';
        break;
      case 'double':
        if (ch === '\\') i++; else if (ch === '"' || ch === '\n') state = 'code';
        break;
      case 'template':
        if (ch === '\\') i++; else if (ch === '`') state = 'code';
        break;
    }
  }
  return out.join('');
}

/** Closes a balanced run starting after `open`, skipping string contents. */
function matchBalanced(source: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/** The first argument of a call, with the argument list already balanced. */
function firstArgument(args: string): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** A translation key: dotted segments of identifier characters. */
const KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
/** `t(` or `i18n.t(` call sites; not `.t(` on other receivers. */
const CALL_RE = /(?<![\w$.])(?:i18n\.)?t\s*\(/g;
/** Same, anchored: an expression whose message comes from the catalog. */
const T_CALL_HEAD_RE = /(?:^|[^.\w$])(?:i18n\.)?t\s*\(/;

/**
 * Whether a raw literal is untranslated English UI prose.
 *
 * Exempt: catalog keys (checked by job 1), single lowercase technical
 * tokens (`downloading`, `top-right`, `Q8_0`), Tailwind class lists, and
 * anything without letters. A single capitalized word (`Active`, `Undo`) is
 * prose — that is exactly what the missed literals looked like. A multi-word
 * literal is prose unless every token reads like a utility class.
 */
function isProseLiteral(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false;
  if (/^[A-Za-z0-9]+$/.test(trimmed)) {
    // Single word: capitalized words are prose, lowercase technical tokens
    // (`downloading`, `stopping`, `transcribeCpp`) are not.
    return /^[A-Z][a-z]/.test(trimmed);
  }
  if (/^[A-Za-z0-9._:/@?&=%+\#-]+$/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const sentencePunctuation = tokens.some(t => /[.!?;:]$/.test(t) || t === '—' || t === '–');
  const allUtilityLike = tokens.every(t => /^[a-z][a-z0-9[\](){}.,/%#_-]*$/.test(t));
  if (allUtilityLike && !sentencePunctuation) return false;
  return /[A-Za-z]{2,}/.test(trimmed);
}

/**
 * String literals in `fragment`, each with its offset in `fragment`. For a
 * template literal, its static segments are the literals (the pieces that
 * shipped in English before `t()` existed), and the scan recurses into the
 * `${...}` interiors — exactly where `AudioLevelMeter` hid `'Active'` /
 * `'Inactive'` behind a localized-looking template.
 */
function literalsIn(fragment: string): Array<{ text: string; start: number }> {
  const found: Array<{ text: string; start: number }> = [];
  const re = /(['"`])((?:\\.|[^\\])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment))) {
    if (match[1] !== '`') {
      found.push({ text: match[2], start: match.index });
      continue;
    }
    const template = match[0];
    const templateStart = match.index;
    let pieceStart = 1;
    let k = 1;
    const pushPiece = (end: number) => {
      const raw = template.slice(pieceStart, end);
      if (raw) found.push({ text: raw.replace(/\\(["'`\\])/g, '$1'), start: templateStart + pieceStart });
    };
    while (k < template.length - 1) {
      if (template[k] === '\\') { k += 2; continue; }
      if (template[k] === '$' && template[k + 1] === '{') {
        pushPiece(k);
        const innerStart = k + 2;
        let depth = 1;
        k += 2;
        while (k < template.length - 1 && depth > 0) {
          if (template[k] === '{') depth++;
          else if (template[k] === '}') depth--;
          k++;
        }
        // Recurse into the interpolation (without its braces).
        const inner = template.slice(innerStart, k - 1);
        for (const nested of literalsIn(inner)) {
          found.push({ text: nested.text, start: templateStart + innerStart + nested.start });
        }
        pieceStart = k;
        continue;
      }
      k++;
    }
    pushPiece(template.length - 1);
  }
  return found;
}

/** The line a source offset falls on (1-based). */
function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/** The end of the physical line containing `offset`. */
function lineEnd(source: string, offset: number): number {
  const nl = source.indexOf('\n', offset);
  return nl === -1 ? source.length : nl;
}

/** The `i18n-usage-allow` marker on the literal's own line exempts it. */
function isAllowed(source: string, offset: number): boolean {
  return /i18n-usage-allow/.test(source.slice(offset, lineEnd(source, offset)));
}

type Violation = { shape: string; text: string; where: string };

/** Toast helpers whose first argument renders as the visible message. */
const TOAST_HELPER_RE = /(?<![\w$.])toast(?:\.(?:error|success|info|warning|loading))?\s*\(/g;
/** `title=` JSX attributes: static `title="…"` or `title={…}`. */
const TITLE_ATTR_RE = /(?<![\w$.])title\s*=\s*(?:"([^"]*)"|\{)/g;
/** `statusMessage` property assignments in object literals. */
const STATUS_MESSAGE_RE = /(?<![\w$.])statusMessage\s*:\s*/g;

/**
 * The untranslated-literal scan over one source string (comments already
 * stripped by `stripComments`). `label` names the file in reported
 * positions. Pure function: the regression fixtures run it directly, so a
 * guard that stops detecting reintroduced literals fails loudly instead of
 * silently passing on a clean-looking src/ result.
 */
export function scanSource(source: string, label: string): Violation[] {
  const violations: Violation[] = [];
  const report = (shape: string, text: string, offset: number) => {
    if (KEY_RE.test(text)) return; // a t() key, checked by job 1
    if (!isProseLiteral(text)) return;
    if (isAllowed(source, offset)) return;
    violations.push({ shape, text, where: `${label}:${lineAt(source, offset)}` });
  };

  let match: RegExpExecArray | null;

  // Shape 1: toast helpers — the first argument is the rendered message.
  // An argument headed by t()/i18n.t() is localized and exempt.
  TOAST_HELPER_RE.lastIndex = 0;
  while ((match = TOAST_HELPER_RE.exec(source))) {
    const open = match.index + match[0].length - 1;
    const close = matchBalanced(source, open, '(', ')');
    const argStart = open + 1;
    const arg = firstArgument(source.slice(argStart, close));
    if (T_CALL_HEAD_RE.test(` ${arg}`)) continue;
    for (const literal of literalsIn(arg)) {
      report('toast', literal.text, argStart + literal.start);
    }
  }

  // Shape 2: title= attributes — a JSX tooltip label is user-visible text.
  TITLE_ATTR_RE.lastIndex = 0;
  while ((match = TITLE_ATTR_RE.exec(source))) {
    if (match[1] !== undefined) {
      const textStart = match.index + match[0].length - match[1].length - 1;
      report('title', match[1], textStart);
      continue;
    }
    const open = match.index + match[0].length - 1; // the '{'
    const close = matchBalanced(source, open, '{', '}');
    const argStart = open + 1;
    const expr = source.slice(argStart, close);
    if (T_CALL_HEAD_RE.test(` ${expr}`)) continue;
    for (const literal of literalsIn(expr)) {
      report('title', literal.text, argStart + literal.start);
    }
  }

  // Shape 3: statusMessage property assignments (the lifecycle message field
  // that shipped 'Starting recording...' / 'Stopping recording...' in
  // English). A variable value is allowed: the check is on English prose.
  // The hooks' setStatus(status, '...') message parameter was deleted along
  // with this field's last consumers — it only ever fed console.log — so
  // object-literal assignments are the remaining place English can return.
  STATUS_MESSAGE_RE.lastIndex = 0;
  while ((match = STATUS_MESSAGE_RE.exec(source))) {
    const offset = match.index + match[0].length;
    let depth = 0;
    let end = offset;
    let inString: string | null = null;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (inString) {
        if (ch === '\\') end++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') inString = ch;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
    for (const literal of literalsIn(source.slice(offset, end))) {
      report('statusMessage', literal.text, offset + literal.start);
    }
  }

  return violations;
}

type UsedKey = { key: string; where: string };

/** src files the guards sweep: the app tree, minus the catalogs themselves. */
function appSources(): string[] {
  const files = Array.from(new Glob('src/**/*.{ts,tsx}').scanSync())
    .filter(file => !file.startsWith('src/i18n/locales'))
    .sort();
  expect(files.length).toBeGreaterThan(50); // the glob must actually see the app
  return files;
}

async function scanKeys(files: string[]): Promise<UsedKey[]> {
  const used: UsedKey[] = [];
  for (const file of files) {
    const source = stripComments(await Bun.file(file).text());
    let match: RegExpExecArray | null;
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(source))) {
      const open = match.index + match[0].length - 1;
      const close = matchBalanced(source, open, '(', ')');
      const args = firstArgument(source.slice(open + 1, close));
      for (const literal of args.matchAll(/(['"])([^'"\n]*)\1/g)) {
        const key = literal[2];
        if (!KEY_RE.test(key)) continue; // options objects, plain strings, etc.
        const line = source.slice(0, match.index).split('\n').length;
        used.push({ key, where: `${file}:${line}` });
      }
    }
  }
  return used;
}

async function scanLiterals(files: string[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of files) {
    const source = stripComments(await Bun.file(file).text());
    violations.push(...scanSource(source, file));
  }
  return violations;
}

const appFiles = appSources();
const usedKeys = await scanKeys(appFiles);
const literalViolations = await scanLiterals(appFiles);

describe('translation key usage', () => {
  test('the scan sees a meaningful share of the catalog', () => {
    // A broken regex or glob would make the guard vacuously pass.
    expect(usedKeys.length).toBeGreaterThan(200);
    const distinct = new Set(usedKeys.map(usage => usage.key));
    expect(distinct.size).toBeGreaterThan(150);
  });

  test('every literal t() key exists in the English catalog', () => {
    const missing = usedKeys
      .filter(usage => !catalogHas(en, usage.key))
      .map(usage => `${usage.key} (${usage.where})`);
    expect(missing).toEqual([]);
  });

  test('every literal t() key exists in the Russian catalog', () => {
    const missing = usedKeys
      .filter(usage => !catalogHas(ru, usage.key))
      .map(usage => `${usage.key} (${usage.where})`);
    expect(missing).toEqual([]);
  });
});

describe('English literals bypassing i18n', () => {
  test('no English prose in toast helper, title= or statusMessage shapes', () => {
    expect(literalViolations).toEqual([]);
  });
});

describe('the literal guard detects reintroduced English strings', () => {
  // Regression fixtures for native-i18n ticket 09: the bypasses the old
  // guard missed must fail the new one. Each shape is proven on the exact
  // literal that shipped untranslated, so an edit that neuters the scan (a
  // broken regex, a dropped shape) fails here rather than shipping English
  // to users again.

  const detect = (shape: string, source: string) =>
    scanSource(stripComments(source), 'fixture.tsx')
      .filter(v => v.shape === shape)
      .map(v => v.text);

  test('toast helpers: the microphone toasts are caught', () => {
    expect(detect('toast', `
      toast.info(\`Microphone switched to \${label} for this meeting.\`, { duration: 6000 });
      toast.error('No microphone available — recording system audio only.', { duration: 8000 });
      toast.error(\`Microphone '\${label}' could not be recovered — recording continues without a microphone.\`);
    `)).toEqual([
      'Microphone switched to ',
      ' for this meeting.',
      'No microphone available — recording system audio only.',
      "Microphone '",
      "' could not be recovered — recording continues without a microphone.",
    ]);
  });

  test('toast helpers: an English t() fallback literal is caught', () => {
    expect(detect('toast', `
      toast.error(error as string || 'Failed to open recording folder');
    `)).toEqual(['Failed to open recording folder']);
  });

  test('toast helpers: localized calls are not flagged', () => {
    expect(detect('toast', `
      toast.info(t('toasts.recording.saved'), { duration: 5000 });
      toast.error(i18n.t('toasts.summary.failedRegenerate'), { description: message });
      toast.info(\`🔴 \${i18n.t('recordingNotification.title')}\`, { duration: 10000 });
      toast.error('', { description: userMessage });
    `)).toEqual([]);
  });

  test('title= attributes: English tooltips are caught', () => {
    expect(detect('title', `
      <button title="Undo" onClick={handleUndo} />
      <button title="Redo" onClick={handleRedo} />
      <div title={\`\${deviceName} - \${isActive ? 'Active' : 'Inactive'}\`} />
    `)).toEqual(['Undo', 'Redo', 'Active', 'Inactive']);
  });

  test('title= attributes: localized and variable titles are not flagged', () => {
    expect(detect('title', `
      <button title={t('summary.ai.undo')} />
      <Button title={isFallback ? t('summary.language.buttonTitleLocal', { language }) : t('summary.language.buttonTitle', { language })} />
      <div title={item.title} />
      <span title={chipTitle} />
    `)).toEqual([]);
  });

  test('statusMessage assignments: English lifecycle messages are caught', () => {
    expect(detect('statusMessage', `
      setState(prev => ({ ...prev, status: RecordingStatus.STARTING, statusMessage: 'Starting recording...' }));
      setState(prev => ({ status: RecordingStatus.STOPPING, statusMessage: 'Stopping recording...' }));
    `)).toEqual(['Starting recording...', 'Stopping recording...']);
    // The remaining shape after the ticket-09 deletion: a variable or an
    // absent field is fine, English prose is not.
    expect(detect('statusMessage', `
      setState(prev => ({ ...prev, status: s, statusMessage: message }));
      setState({ status: RecordingStatus.IDLE, statusMessage: undefined });
    `)).toEqual([]);
  });

  test('the allow-marker exempts a deliberate literal', () => {
    expect(detect('title', `
      <div title="Samobranka" /> // i18n-usage-allow brand name
      <button title="Undo" onClick={handleUndo} />
    `)).toEqual(['Undo']);
  });
});
