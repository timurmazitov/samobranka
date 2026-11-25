"use client";

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Download } from 'lucide-react';
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
      {/* Copy button */}
      <Button
        variant="outline"
        size="sm"
        title={t('summary.updater.copyTitle')}
        onClick={() => {
          onCopy();
        }}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden @[40rem]:inline">{t('common.copy')}</span>
      </Button>

      {/* Export button */}
      <Button
        variant="outline"
        size="sm"
        title={t('summary.updater.exportTitle')}
        onClick={() => {
          onExport();
        }}
        className="cursor-pointer"
      >
        <Download />
        <span className="hidden @[40rem]:inline">{t('summary.updater.export')}</span>
      </Button>

    </ButtonGroup>
  );
}
