import React from "react";
import { scan } from "react-scan";
scan({
  enabled: true,
});

import { useEffect, useMemo, useRef, useState } from "react";
import deepEqual from "fast-deep-equal";
import { toast } from "sonner";

import {
  GetGoServerPort,
  SyncWithDavinci,
} from "@wails/go/main/App";

import { GetPythonReadyStatus } from "@wails/go/main/App";
import { EventsOn } from "@wails/runtime";
import { main } from "@wails/go/models";

import WaveformPlayer from "./components/audio/waveform";
import RemoveSilencesButton from "./lib/PythonRunner";
import { ActiveClip, DetectionParams } from "./types";
import { useWindowFocus } from "./hooks/hooks";
import FileSelector from "./components/ui-custom/fileSelector";
import GlobalAlertDialog from "./components/ui-custom/GlobalAlertDialog";
import { createPortal } from "react-dom";
import { ThresholdControl } from "./components/controls/ThresholdControl";
import { TitleBar } from "./components/ui-custom/titlebar";

import { useSyncBusyState } from "./stores/appSync";

import { useClipStore } from '@/stores/clipStore';
import { SilenceControls } from "./components/controls/SilenceControls";


EventsOn("showToast", (data) => {
  console.log("Event: showToast", data);
  // Simple alert for now, TODO: use nicer shadcn component
  alert(`Toast [${data.toastType || "info"}]: ${data.message}`);
});

EventsOn("projectDataReceived", (projectData: main.ProjectDataPayload) => {
  console.log("Event: projectDataReceived", projectData);
});


EventsOn("taskUpdate", (data) => {
  console.log("Event: taskUpdate", data);
  // Simple alert for now, TODO: use nicer shadcn component
  alert(`Update! ${data}`);
});


const DEFAULT_THRESHOLD = -30;
const DEFAULT_MIN_DURATION = 1.0;
const MIN_DURATION_LIMIT = 0.01;
const DEFAULT_PADDING = 0.25;
const MIN_CONTENT_DURATION = 0.5


const getDefaultDetectionParams = (): DetectionParams => ({
  loudnessThreshold: DEFAULT_THRESHOLD,
  minSilenceDurationSeconds: DEFAULT_MIN_DURATION,
  minContentDuration: MIN_DURATION_LIMIT,
  paddingLeftSeconds: DEFAULT_PADDING,
  paddingRightSeconds: DEFAULT_PADDING,
  // If you want to store paddingLocked per-clip, add it here:
  // paddingLocked: true,
});


const createActiveFileFromTimelineItem = (
  item: main.TimelineItem,
  port: Number
): ActiveClip | null => {
  if (
    !item.processed_file_name ||
    typeof item.source_start_frame !== "number" ||
    typeof item.source_end_frame !== "number"
  ) {
    console.warn(
      "TimelineItem is missing critical data (ProcessedFileName, SourceStartFrame, or SourceEndFrame):",
      item
    );
    return null;
  }
  const id = item.id || item.processed_file_name; // Prefer item.ID if available and unique
  return {
    id: id,
    name: item.name || "Unnamed Track Item", // Fallback for name
    sourceFilePath: item.source_file_path,
    processedFileName: item.processed_file_name,
    previewUrl: `http://localhost:${port}/${item.processed_file_name}.wav`,
    sourceStartFrame: item.source_start_frame,
    sourceEndFrame: item.source_end_frame,
  };
};


function AppContent() {
  const isBusy = useSyncBusyState(s => s.isBusy);
  const setBusy = useSyncBusyState(s => s.setBusy);
  const currentClipId = useClipStore(s => s.currentClipId);
  const setCurrentClipId = useClipStore(s => s.setCurrentClipId);

  const [httpPort, setHttpPort] = useState<number | null>(null);
  const [projectData, setProjectData] =
    useState<main.ProjectDataPayload | null>(null);

  useEffect(() => {
    const audioItems = projectData?.timeline?.audio_track_items || [];
    if (audioItems.length === 0) {
      if (currentClipId !== null) {
        setCurrentClipId(null); // No clips available, so deselect
      }
      return;
    }

    const availableIds = new Set(audioItems.map(item => item.id || item.processed_file_name));

    // If no clip is selected, or the selected clip no longer exists,
    // default to the first one in the list.
    if (!currentClipId || !availableIds.has(currentClipId)) {
      const firstItemId = audioItems[0].id || audioItems[0].processed_file_name;
      setCurrentClipId(firstItemId);
    }
  }, [projectData, currentClipId, setCurrentClipId]);


  // 3. Use useMemo for PURE calculations. It now only derives the active clip.
  const currentActiveClip = useMemo(() => {
    if (!projectData || !httpPort || !projectData.timeline?.audio_track_items) {
      return null;
    }

    const audioItems = projectData.timeline.audio_track_items;
    if (audioItems.length === 0) return null;

    // Find the item corresponding to the current ID.
    let itemToDisplay = currentClipId
      ? audioItems.find(item => (item.id || item.processed_file_name) === currentClipId)
      : audioItems[0];

    // Fallback if the ID wasn't found (e.g., during a state transition)
    if (!itemToDisplay) {
      itemToDisplay = audioItems[0];
    }

    return createActiveFileFromTimelineItem(itemToDisplay, httpPort);

  }, [projectData, httpPort, currentClipId]);


  const [activeClipSegmentPeakData, setActiveClipSegmentPeakData] =
    useState<main.PrecomputedWaveformData | null>(null);

  // This state will hold the URL for the dynamically rendered clip segment
  const [cutAudioSegmentUrl, setCutAudioSegmentUrl] = useState<string | null>(
    null
  );

  const handleSync = async () => {
    if (isBusy) {
      console.log("Sync skipped: App is busy.");
      return;
    }
    console.log("syncing...")
    setBusy(true);
    const loadingToastId = toast.loading("Syncing with DaVinci Resolve…");

    const conditionalSetProjectData = (
      newData: main.ProjectDataPayload | null
    ) => {
      if (!deepEqual(projectData, newData)) {
        // Using fast-deep-equal
        setProjectData(newData);
        console.log("handleSync: Project data updated.");
      } else {
        console.log(
          "handleSync: New project data is identical to current; skipping state update for projectData."
        );
      }
    };

    try {
      const response = await SyncWithDavinci();
      console.log("SyncWithDavinci response from Go:", response);

      if (response && response.alertIssued) {
        console.warn(
          "Sync operation resulted in an alert (issued by Go). Message:",
          response.message
        );
        conditionalSetProjectData(response.data || null);
        toast.dismiss(loadingToastId);
      } else if (response && response.status !== "success") {
        console.error(
          "Sync failed (Python reported error, no global alert by Go):",
          response.message
        );
        setProjectData(null);
        toast.error("Sync failed", {
          id: loadingToastId,
          description: response.message || "An error occurred during sync.",
          duration: 5000,
        });
        setBusy(false);
      } else if (response && response.status === "success") {
        conditionalSetProjectData(response.data);
        toast.success("Synced with DaVinci Resolve", {
          id: loadingToastId,
          duration: 1500,
        });
        setBusy(false);
      } else {
        console.error(
          "SyncWithDavinci: Unexpected response structure from Go",
          response
        );
        setProjectData(null);
        toast.error("Sync failed: Unexpected response format", {
          id: loadingToastId,
          duration: 5000,
        });
        setBusy(false);
      }
    } catch (err: any) {
      console.error("Error calling SyncWithDavinci or Go-level error:", err);
      setProjectData(null);

      if (err && err.alertIssued) {
        toast.dismiss(loadingToastId);
      } else {
        const errorMessage =
          err?.message ||
          (typeof err === "string" ? err : "An unknown error occurred.");
        toast.error("Sync Error", {
          id: loadingToastId,
          description: `${errorMessage}`,
          duration: 5000,
        });
      }
      setBusy(false);
    }
  };

  const initialInitDone = useRef(false); // Ref to track if the effect has run

  useEffect(() => {
    const getInitialServerInfo = async () => {
      if (initialInitDone.current) return;
      console.log("App.tsx: Attempting to get Go HTTP server port...");
      try {
        const port = await GetGoServerPort();

        if (port && port > 0) {
          console.log("App.tsx: HTTP Server Port received:", port);
          setHttpPort(port); // This will trigger a re-render

          const pyReady = await GetPythonReadyStatus();
          console.log("App.tsx: Python ready status:", pyReady);
        } else {
          console.error(
            "App.tsx: GetGoServerPort() returned an invalid or zero port:",
            port
          );
          setHttpPort(null);
          setCurrentClipId(null);
          // Optionally, inform the user that the audio server isn't available
        }

        await handleSync();
      } catch (err) {
        console.error("App.tsx: Error during initial server info fetch:", err);
        setHttpPort(null);
        setCurrentClipId(null);
      }
    };
    getInitialServerInfo();
    return () => {
      initialInitDone.current = true;
    };
  }, []);

  // Effect to register Wails event listeners (runs once on mount)
  useEffect(() => {
    const handleProjectData = (data: main.ProjectDataPayload) => {
      console.log(
        "Event: projectDataReceived in App.tsx, setting state.",
        data
      );
      setProjectData(data);
    };
    // Register the event listener
    const unsubscribe = EventsOn("projectDataReceived", handleProjectData);
    // It's good practice to have a cleanup, though Wails might handle it.
    // If EventsOn returns a function to unlisten, use it here.
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  useWindowFocus(
    () => handleSync(),
    () => console.log("Tab is blurred"),
    { fireOnMount: false, throttleMs: 500 }
  );


  const handleAudioClipSelection = (selectedItemId: string) => {
    setCurrentClipId(selectedItemId);
    console.log(
      "FileSelector onFileChange: currentClipId set to:",
      selectedItemId
    );
  };

  const titleBarHeight = "2.25rem";
  return (
    <>
      <div
        className="p-6 pt-3 bg-[#28282e] border-1 border-t-0 border-zinc-900"
        style={{
          marginTop: titleBarHeight,
          height: `calc(100vh - ${titleBarHeight})`,
          overflowY: "auto", // Make this div scrollable
        }}
      >
        <header className="flex items-center justify-between"></header>
        <main className="flex-1 gap-8 max-w-screen select-none space-y-4">
          {projectData?.files && currentActiveClip?.id && (
            <FileSelector
              audioItems={projectData?.timeline?.audio_track_items}
              currentFileId={currentClipId}
              onFileChange={handleAudioClipSelection}
              fps={projectData?.timeline?.fps}
              disabled={
                !httpPort ||
                !projectData?.timeline?.audio_track_items ||
                projectData.timeline.audio_track_items.length === 0
              }
              className="w-full mt-2"
            />
          )}
          <div className="flex flex-col space-y-8">
            {/* Group Threshold, Min Duration, and Padding */}
            <div className="flex flex-row space-x-6 items-start">
              {currentClipId && (
                <>
                  <ThresholdControl key={currentClipId} />
                  <div className="flex flex-col space-y-2 w-full min-w-0 p-0 overflow-visible">
                    {httpPort &&
                      currentActiveClip &&
                      projectData &&
                      projectData.timeline &&
                      (
                        <WaveformPlayer
                          activeClip={currentActiveClip}
                          projectFrameRate={projectData.timeline.fps}
                          httpPort={httpPort}
                        />
                      )}

                  </div>
                </>
              )}
            </div>
            <div className="space-y-2 w-full p-5">
              <SilenceControls key={currentClipId} />
            </div>
            <div className="flex space-y-8 w-full">
              <div className="items-center space-y-2 mt-4">
                {projectData && (
                  <RemoveSilencesButton
                    projectData={projectData}
                    keepSilenceSegments={false}
                    defaultDetectionParams={getDefaultDetectionParams()}
                  />
                )}
              </div>
            </div>

          </div>
        </main>
        <div id="dialog-portal-container" />
      </div>
    </>
  );
}

export default function App() {

  interface ClientPortalProps {
    children: React.ReactNode; // The standard type for any valid React child
    targetId: string;
  }

  const ClientPortal = ({ children, targetId }: ClientPortalProps) => {
    if (typeof window === 'undefined') return null; // Skip SSR

    const container = document.getElementById(targetId);
    return container ? createPortal(children, container) : null;
  };

  const MemoizedTitleBar = useMemo(() => <TitleBar />, []);

  return (
    <>
      <ClientPortal targetId="overlays">
        <GlobalAlertDialog />
      </ClientPortal>

      <ClientPortal targetId="title-bar-root">
        {MemoizedTitleBar}
      </ClientPortal>
      <AppContent />
    </>
  )
}