"use client";

import { useEffect, useRef } from "react";
import type { BlockNoteEditor, PartialBlock, Block } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTranslation } from 'react-i18next';
import { blocknoteDictionary } from '@/lib/blocknote-i18n';
import { FindHighlightExtension } from './FindHighlightExtension';
import "@blocknote/shadcn/style.css";
import "@blocknote/core/fonts/inter.css";

interface EditorProps {
  initialContent?: Block[];
  onChange?: (blocks: Block[]) => void;
  editable?: boolean;
  /**
   * Escape hatch for the find & replace highlight: the live editor instance
   * (0.36 exposes none otherwise), reported once it exists and again when a
   * language switch recreates it.
   */
  onEditorReady?: (editor: BlockNoteEditor) => void;
}

export default function Editor({ initialContent, onChange, editable = true, onEditorReady }: EditorProps) {
  console.log('📝 EDITOR: Initializing BlockNote editor with blocks:', {
    hasContent: !!initialContent,
    blocksCount: initialContent?.length || 0,
    editable
  });

  const { i18n } = useTranslation();
  // Keep the latest document so a language switch (which recreates the editor
  // below, because BlockNote 0.36 fixes its dictionary at creation time)
  // re-seeds with the user's current content instead of the initial one.
  const documentRef = useRef<Block[] | undefined>(initialContent);

  // One extension instance per editor creation: language switches recreate
  // the editor (deps below), so the ref is re-seeded with each new language.
  const highlightExtensionRef = useRef<FindHighlightExtension | null>(null);
  const highlightLanguageRef = useRef<string | undefined>(undefined);
  if (highlightLanguageRef.current !== i18n.language || !highlightExtensionRef.current) {
    highlightLanguageRef.current = i18n.language;
    highlightExtensionRef.current = new FindHighlightExtension();
  }

  const editor = useCreateBlockNote(
    {
      initialContent: documentRef.current as PartialBlock[] | undefined,
      dictionary: blocknoteDictionary(i18n.language),
      // The find panel's match highlights ride this plugin (see the file for
      // why 0.36 needs the raw extension point).
      extensions: [highlightExtensionRef.current],
    },
    // Recreate the editor when the UI language changes so its menus, slash
    // menu, and tooltips come up in the new language (native-i18n).
    [i18n.language],
  );

  console.log('📝 EDITOR: BlockNote editor created successfully');

  // Report the live instance so the summary surface can map match ranges to
  // document positions and push them into the highlight plugin.
  useEffect(() => {
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  // Handle content changes
  useEffect(() => {
    if (!onChange) return;

    const handleChange = () => {
      console.log('📝 EDITOR: Content changed, notifying parent...', {
        blocksCount: editor.document.length
      });
      documentRef.current = editor.document;
      onChange(editor.document);
    };

    const unsubscribe = editor.onChange(handleChange);

    return () => {
      if (typeof unsubscribe === 'function') {
        console.log('📝 EDITOR: Cleaning up onChange listener');
        unsubscribe();
      }
    };
  }, [editor, onChange]);

  return <BlockNoteView editor={editor} editable={editable} theme="light" />;
}
