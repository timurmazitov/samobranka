"use client";

import { useEffect, useRef } from "react";
import type { PartialBlock, Block } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTranslation } from 'react-i18next';
import { blocknoteDictionary } from '@/lib/blocknote-i18n';
import "@blocknote/shadcn/style.css";
import "@blocknote/core/fonts/inter.css";

interface EditorProps {
  initialContent?: Block[];
  onChange?: (blocks: Block[]) => void;
  editable?: boolean;
}

export default function Editor({ initialContent, onChange, editable = true }: EditorProps) {
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

  const editor = useCreateBlockNote(
    {
      initialContent: documentRef.current as PartialBlock[] | undefined,
      dictionary: blocknoteDictionary(i18n.language),
    },
    // Recreate the editor when the UI language changes so its menus, slash
    // menu, and tooltips come up in the new language (native-i18n).
    [i18n.language],
  );

  console.log('📝 EDITOR: BlockNote editor created successfully');

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
