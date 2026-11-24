import { BlockNoteExtension } from '@blocknote/core';

import { createFindHighlightPlugin } from '@/lib/summary-find-decorations';

/**
 * The BlockNote 0.36 registration path for the find-highlight plugin:
 * 0.36 has no `editor.ui.buildEditorDecorations`, so a decoration plugin
 * reaches the editor through this extension point — subclass
 * `BlockNoteExtension`, register the raw ProseMirror plugin with the
 * protected `addProsemirrorPlugin`, and pass an instance in the
 * `extensions` option of `useCreateBlockNote`.
 *
 * Lives next to the editor components (not in `src/lib`) so the module
 * graph keeps `@blocknote/core`'s CSS side effect off the headless/lib
 * paths; create a fresh instance per editor so each editor gets its own
 * plugin instance. The plugin itself (ranges in, decorations out) is pure
 * and unit-tested in `tests/lib/summary-find-decorations.test.ts`.
 */
export class FindHighlightExtension extends BlockNoteExtension {
  constructor() {
    super();
    this.addProsemirrorPlugin(createFindHighlightPlugin());
  }
}
