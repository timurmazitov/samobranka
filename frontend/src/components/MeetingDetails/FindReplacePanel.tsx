'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import '@/i18n';

interface FindReplacePanelProps {
    /** Whether the panel is mounted: the page keeps it mounted only while open. */
    open: boolean;
    query: string;
    onQueryChange: (query: string) => void;
    caseSensitive: boolean;
    onCaseSensitiveChange: (value: boolean) => void;
    wholeWord: boolean;
    onWholeWordChange: (value: boolean) => void;
    /** 1-based position in the match list; 0 when nothing is active. */
    current: number;
    /** Total matches; with a typed query and 0 total the field turns red. */
    total: number;
    /** A non-blank query is typed — distinguishes «0 / 0» from an empty query. */
    hasQuery: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onClose: () => void;
    /** Which field to focus on open: Ctrl+H lands the caret in «Заменить». */
    focusTarget: 'search' | 'replace';
    /** Changes on every open so the focus effect re-runs on reopen. */
    focusNonce: number;
    /** Sidebar width compensation, same pattern as the status overlays. */
    sidebarCollapsed: boolean;
}

/**
 * The floating «Найти и заменить» card: fixed top-right with the sidebar
 * width compensation of the status overlays, deliberately not a Radix Dialog
 * so the text under it stays clickable and scrolls during navigation. The
 * «Заменить» field is present but inert in this ticket — replacement lands
 * with ticket 03, which can add its buttons and actions here without moving
 * anything. Enter / Shift+Enter walk the match list like ↑/↓ do.
 */
export function FindReplacePanel({
    open,
    query,
    onQueryChange,
    caseSensitive,
    onCaseSensitiveChange,
    wholeWord,
    onWholeWordChange,
    current,
    total,
    hasQuery,
    onPrevious,
    onNext,
    onClose,
    focusTarget,
    focusNonce,
    sidebarCollapsed,
}: FindReplacePanelProps) {
    const { t } = useTranslation();
    const searchRef = useRef<HTMLInputElement>(null);
    const replaceRef = useRef<HTMLInputElement>(null);

    // Focus follows the open request: Ctrl+F lands in «Искать», Ctrl+H in
    // «Заменить». The nonce makes a reopen re-run the effect even when the
    // same field is requested twice in a row.
    useEffect(() => {
        if (!open) return;
        if (focusTarget === 'replace') replaceRef.current?.focus();
        else searchRef.current?.focus();
    }, [open, focusTarget, focusNonce]);

    if (!open) return null;

    const navigateOnEnter = (event: React.KeyboardEvent) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
        } else if (event.key === 'Escape') {
            // The panel's own Esc handler; the page listener covers the rest.
            event.preventDefault();
            onClose();
        }
    };

    const noMatches = hasQuery && total === 0;

    return (
        <div className="fixed top-4 right-0 z-20">
            <div
                className="pr-4 transition-[margin] duration-300"
                style={{ marginRight: sidebarCollapsed ? '4rem' : '16rem' }}
            >
                <div className="w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-700">
                            {t('findReplace.title')}
                        </span>
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                            title={t('common.close')}
                            aria-label={t('common.close')}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="flex items-center gap-1">
                        <div className="flex-1">
                            <Input
                                ref={searchRef}
                                value={query}
                                onChange={(event) => onQueryChange(event.target.value)}
                                onKeyDown={navigateOnEnter}
                                placeholder={t('findReplace.searchPlaceholder')}
                                aria-label={t('findReplace.searchPlaceholder')}
                                className={cn(
                                    'h-8 text-sm',
                                    noMatches && 'border-red-500 focus-visible:ring-red-500',
                                )}
                            />
                            <Input
                                ref={replaceRef}
                                // Inert until ticket 03 gives replacement a
                                // command path; the field previews the UI.
                                placeholder={t('findReplace.replacePlaceholder')}
                                aria-label={t('findReplace.replacePlaceholder')}
                                className="mt-2 h-8 text-sm"
                                onKeyDown={navigateOnEnter}
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8"
                                onClick={onPrevious}
                                disabled={total === 0}
                                title={t('findReplace.previousMatch')}
                                aria-label={t('findReplace.previousMatch')}
                            >
                                <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8"
                                onClick={onNext}
                                disabled={total === 0}
                                title={t('findReplace.nextMatch')}
                                aria-label={t('findReplace.nextMatch')}
                            >
                                <ChevronDown className="h-4 w-4" />
                            </Button>
                        </div>
                        <span
                            className={cn(
                                'min-w-[3.5rem] text-center text-sm tabular-nums',
                                noMatches ? 'text-red-600' : 'text-gray-500',
                            )}
                        >
                            {current} / {total}
                        </span>
                    </div>

                    <div className="mt-2 flex items-center gap-4">
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                            <input
                                type="checkbox"
                                checked={caseSensitive}
                                onChange={(event) => onCaseSensitiveChange(event.target.checked)}
                                className="h-3.5 w-3.5 rounded border-gray-300"
                            />
                            {t('findReplace.caseSensitive')}
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                            <input
                                type="checkbox"
                                checked={wholeWord}
                                onChange={(event) => onWholeWordChange(event.target.checked)}
                                className="h-3.5 w-3.5 rounded border-gray-300"
                            />
                            {t('findReplace.wholeWord')}
                        </label>
                    </div>
                </div>
            </div>
        </div>
    );
}
