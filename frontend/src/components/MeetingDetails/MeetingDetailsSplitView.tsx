'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PanelToolbarOutletContext } from './panel-toolbar';
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
  // The active panel registers its button row here; the bar renders it next
  // to the toggles. Withdrawn automatically when the panel unmounts on a tab
  // switch.
  const [toolbarOutlet, setToolbarOutlet] = useState<ReactNode>(null);

  return (
    <PanelToolbarOutletContext.Provider value={setToolbarOutlet}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as MeetingDetailsTab)}
        className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {/* One toolbar bar: the mode toggles on the left, the active mode's
            buttons (registered by the mounted panel) flowing right after
            them. `@container`: the button rows carry @[…rem] label rules that
            used to resolve against the panel root, which is no longer their
            ancestor once they render here. */}
        <div className="@container flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-2">
          <TabsList className="relative h-auto shrink-0 rounded-none border-0 bg-transparent p-0">
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
          {toolbarOutlet}
        </div>
        <div className="flex flex-1 min-h-0 min-w-0 flex-col">
          {/* Radix leaves an empty wrapper div with the `hidden` attribute
              for the inactive tab; the preflight `[hidden]` rule loses to
              this element's `flex` class (zero-specificity `:where()`), which
              would make the empty wrapper take a 50% flex share — the
              `[&[hidden]]:hidden` variant pins display:none to the attribute
              and keeps the active panel at full height. */}
          <TabsContent
            value="transcript"
            className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&[hidden]]:hidden"
          >
            {transcript}
          </TabsContent>
          <TabsContent
            value="summary"
            className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&[hidden]]:hidden"
          >
            {summary}
          </TabsContent>
        </div>
      </Tabs>
    </PanelToolbarOutletContext.Provider>
  );
}
