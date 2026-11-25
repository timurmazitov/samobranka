'use client';

import type { ReactNode } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import '@/i18n';

const TABS = [
  { value: 'transcript' as const, labelKey: 'meetingDetails.split.tabTranscript', icon: FileText },
  { value: 'summary' as const, labelKey: 'meetingDetails.split.tabSummary', icon: Sparkles },
];

export type MeetingDetailsTab = 'transcript' | 'summary';

interface MeetingDetailsSplitViewProps {
  transcript: ReactNode;
  summary: ReactNode;
  activeTab: MeetingDetailsTab;
  onTabChange: (tab: MeetingDetailsTab) => void;
}

export function MeetingDetailsSplitView({
  transcript,
  summary,
  activeTab,
  onTabChange,
}: MeetingDetailsSplitViewProps) {
  const { t } = useTranslation();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as MeetingDetailsTab)}
      className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div className="shrink-0 bg-white px-2">
        <TabsList className="relative h-auto w-full justify-center rounded-none border-b border-gray-200 bg-transparent p-0">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="relative z-10 flex items-center gap-2 rounded-none border-0 bg-transparent px-6 py-4 text-gray-600 data-[state=active]:bg-transparent data-[state=active]:text-blue-600 data-[state=active]:shadow-none hover:text-gray-900"
              >
                <Icon className="h-4 w-4" />
                {t(tab.labelKey)}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <TabsContent
          value="transcript"
          className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {transcript}
        </TabsContent>
        <TabsContent
          value="summary"
          className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {summary}
        </TabsContent>
      </div>
    </Tabs>
  );
}
