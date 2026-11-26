import { useTranslation } from 'react-i18next';
import { contentOffset } from '@/lib/layout-offset';

interface StatusOverlaysProps {
  // Status flags
  isProcessing: boolean;      // Processing transcription after recording stops
  isSaving: boolean;          // Saving transcript to database
  // Detecting speakers after the save (the live-stop diarization stage).
  // Optional so existing call sites keep typechecking while they have no
  // speaker stage to report.
  isDetectingSpeakers?: boolean;

  // Layout
  sidebarCollapsed: boolean;  // For responsive margin calculation
  notesColumnWidth: number;   // Width of the permanent notes column
}

// Internal reusable component for individual status overlays
interface StatusOverlayProps {
  show: boolean;
  message: string;
  sidebarCollapsed: boolean;
  notesColumnWidth: number;
}

function StatusOverlay({ show, message, sidebarCollapsed, notesColumnWidth }: StatusOverlayProps) {
  if (!show) return null;

  return (
    <div className="fixed bottom-4 left-0 right-0 z-10">
      <div
        className="flex justify-center pl-8 transition-[margin] duration-300"
        style={{
          marginLeft: contentOffset(sidebarCollapsed, notesColumnWidth)
        }}
      >
        <div className="w-2/3 max-w-[750px] flex justify-center">
          <div className="bg-white rounded-lg shadow-lg px-4 py-2 flex items-center space-x-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900"></div>
            <span className="text-sm text-gray-700">{message}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Main exported component - renders multiple status overlays
export function StatusOverlays({
  isProcessing,
  isSaving,
  isDetectingSpeakers,
  sidebarCollapsed,
  notesColumnWidth
}: StatusOverlaysProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* Processing status overlay - shown after recording stops while finalizing transcription */}
      <StatusOverlay
        show={isProcessing}
        message={t('misc.statusOverlays.finalizingTranscription')}
        sidebarCollapsed={sidebarCollapsed}
        notesColumnWidth={notesColumnWidth}
      />

      {/* Saving status overlay - shown while saving transcript to database */}
      <StatusOverlay
        show={isSaving}
        message={t('misc.statusOverlays.savingTranscript')}
        sidebarCollapsed={sidebarCollapsed}
        notesColumnWidth={notesColumnWidth}
      />

      {/* Speaker stage - shown after the save while the live diarization pass
          is running; skipped silently when no pass runs. */}
      <StatusOverlay
        show={isDetectingSpeakers === true}
        message={t('misc.statusOverlays.detectingSpeakers')}
        sidebarCollapsed={sidebarCollapsed}
        notesColumnWidth={notesColumnWidth}
      />
    </>
  );
}
