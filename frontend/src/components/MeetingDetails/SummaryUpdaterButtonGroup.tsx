"use client";

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, Copy, Download } from 'lucide-react';
import '@/i18n';

interface SummaryUpdaterButtonGroupProps {
  onCopy: () => Promise<void>;
  onExport: () => Promise<void>;
}

export function SummaryUpdaterButtonGroup({
  onCopy,
  onExport,
}: SummaryUpdaterButtonGroupProps) {
  const { t } = useTranslation();
  return (
    <ButtonGroup>
      {/* Copy and export live in one menu behind the Export trigger. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title={t('summary.updater.exportTitle')}
            className="px-2 @[22rem]:px-3"
          >
            <Download />
            <span className="hidden @[22rem]:inline">{t('summary.updater.export')}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => { onCopy(); }}>
            <Copy />
            <span>{t('common.copyToClipboard')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { onExport(); }}>
            <Download />
            <span>{t('common.exportAsMarkdown')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
