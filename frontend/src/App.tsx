import React from "react";
import { scan } from "react-scan";
scan({
  enabled: true,
});

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import deepEqual from "fast-deep-equal";
import { toast } from "sonner";

import {
  CloseApp,
  DownloadFFmpeg,
  GetFFmpegStatus,
  GetGoServerPort,
  MixdownCompoundClips,
  ProcessProjectAudio,
  SyncWithDavinci,
  MakeFinalTimeline,
} from "@wails/go/main/App";

import { GetPythonReadyStatus } from "@wails/go/main/App";
import { EventsEmit, EventsOn } from "@wails/runtime";
import { main } from "@wails/go/models";

import WaveformPlayer from "./components/audio/waveform";
import RemoveSilencesButton, { deriveAllClipDetectionParams, prepareProjectDataWithEdits } from "./lib/PythonRunner";
import { ActiveClip, DetectionParams } from "./types";
import { usePrevious, useWindowFocus } from "./hooks/hooks";
import FileSelector from "./components/ui-custom/fileSelector";
import GlobalAlertDialog from "./components/ui-custom/GlobalAlertDialog";
import { createPortal } from "react-dom";
import { ThresholdControl } from "./components/controls/ThresholdControl";
import { TitleBar } from "./titlebar";

import { useSyncBusyState } from "./stores/appSync";

import {
  defaultParameters,
  useClipStore,
  useGlobalStore,
  useTimecodeStore,
} from "@/stores/clipStore";
import { SilenceControls } from "./components/controls/SilenceControls";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./components/ui/drawer";
import { Button } from "./components/ui/button";
import { Progress } from "./components/ui/progress";
import { DavinciSettings } from "./components/controls/DavinciSettings";
import { useUiStore } from "./stores/uiStore";
import { InfoDialog } from "./InfoDialog";
import { SettingsDialog } from "./SettingsDialog";
import Timecode, { FRAMERATE } from "smpte-timecode";
import { Toaster } from "./components/ui/sonner";
import { PeakMeter } from "./components/audio/peakMeter";
import { initializeProgressListeners } from "./stores/progressStore";
import SliderZag from "./components/ui/sliderZag";



const getDefaultDetectionParams = (): DetectionParams => ({
  loudnessThreshold: defaultParameters.threshold,
  minSilenceDurationSeconds: defaultParameters.minDuration,
  minContent: defaultParameters.minContent,
  paddingLeftSeconds: defaultParameters.paddingLeft,
  paddingRightSeconds: defaultParameters.paddingRight,
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
    startFrame: item.start_frame,
    duration: item.duration
  };
};


function supportsRealBackdrop() {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.width = el.style.height = "10px";
  el.style.backdropFilter = "blur(5px)";
  el.style.visibility = "hidden";
  document.body.appendChild(el);
  const applied = window.getComputedStyle(el).backdropFilter;
  document.body.removeChild(el);
  return applied && applied !== "none";
}

// EventsOn("ffmpeg:missing", (data) => {
//   console.log("Event: MISSING FFMPEG", data);
//   // Simple alert for now, TODO: use nicer shadcn component
//   alert("missing ffmpeg bljiad");
// });

function AppContent() {
  const [sliderValue, setSliderValue] = useState(50);
  const [ffmpegReady, setFFmpegReady] = useState<boolean | null>(null)
  const prevFfmpegReady = usePrevious(ffmpegReady);

  useEffect(() => {
    // Don't do anything until the initial status check is complete.
    if (ffmpegReady === null) {
      return;
    }

    // This condition elegantly handles two scenarios:
    // 1. The initial check finds FFmpeg is ready (null -> true).
    // 2. The user downloads FFmpeg (false -> true).
    if (ffmpegReady === true && prevFfmpegReady !== true) {
      console.log("FFmpeg is ready, calling handleSync.");
      handleSync();
    }
    // This handles the case where the initial check finds FFmpeg is NOT ready.
    else if (ffmpegReady === false && prevFfmpegReady === null) {
      console.log("Initial FFmpeg check failed, calling handleSync to show alert.");
      handleSync();
    }
  }, [ffmpegReady, prevFfmpegReady]);

  const isBusy = useSyncBusyState(s => s.isBusy);
  const setBusy = useSyncBusyState(s => s.setBusy);

  const setHasProjectData = useSyncBusyState(s => s.setHasProjectData);

  const currentClipId = useClipStore(s => s.currentClipId);
  const setCurrentClipId = useClipStore(s => s.setCurrentClipId);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [pendingRemoveSilences, setPendingRemoveSilences] = useState(false);

  const [httpPort, setHttpPort] = useState<number | null>(null);

  //const projectData = useGlobalStore((s) => s.projectData);
  const [projectData, setProjectData] =
    useState<main.ProjectDataPayload | null>(null);

  const setTimecode = useTimecodeStore((s) => s.setTimecode);
  //const setProjectData = useTimecodeStore((s) => s.setProjectData);
  const currTimecode = useTimecodeStore(s => s.timecode);
  const audioItems = projectData?.timeline?.audio_track_items || [];
  const timelineFps = projectData?.timeline?.fps || 30;

  useEffect(() => {
    // If there is no timecode or no clips, there's nothing to select.
    if (audioItems.length === 0) {
      setCurrentClipId(null);
      return;
    }
    if (currTimecode) {
      // 1. Convert the current timecode to frames
      const currentFrame = currTimecode.frameCount;

      // 2. Find the clip that contains the current frame
      // A clip "contains" the frame if the frame is between its start and end markers.
      const clipAtTimecode = audioItems.find(
        (item) =>
          currentFrame >= item.start_frame && currentFrame < item.end_frame
      );
      if (clipAtTimecode) {
        // 3. Update the current clip ID
        const newClipId = clipAtTimecode.id || clipAtTimecode.processed_file_name;
        // Only update state if the ID has actually changed to prevent re-renders
        if (newClipId && newClipId !== currentClipId) {
          setCurrentClipId(newClipId);
        }
      } else if (!currentClipId) {
        setCurrentClipId(
          audioItems[0]?.id || audioItems[0]?.processed_file_name || null
        );
      }

    } else {
      setCurrentClipId(
        audioItems[0]?.id || audioItems[0]?.processed_file_name || null
      );
    }
  }, [currTimecode, audioItems, timelineFps]);

  // 3. Use useMemo for PURE calculations. It now only derives the active clip.
  const currentActiveClip = useMemo(() => {
    if (!projectData || !httpPort || !projectData.timeline?.audio_track_items) {
      return null;
    }
    if (audioItems.length === 0) return null;

    // Find the item corresponding to the current ID.
    let itemToDisplay = currentClipId
      ? audioItems.find(
        (item) => (item.id || item.processed_file_name) === currentClipId
      )
      : audioItems[0];

    // Fallback if the ID wasn't found (e.g., during a state transition)
    if (!itemToDisplay) {
      itemToDisplay = audioItems[0];
    }

    return createActiveFileFromTimelineItem(itemToDisplay, httpPort);
  }, [projectData, httpPort, currentClipId]);


  const handleSync = async () => {
    if (isBusy) {
      console.log("Sync skipped: App is busy.");
      return;
    }
    console.log("syncing...")
    if (ffmpegReady == null) {
      const isFfmpegReady = await GetFFmpegStatus();
      setFFmpegReady(isFfmpegReady);
      return
    }

    if (!ffmpegReady) {
      console.log("no ffmpeg! (handle sync");

      EventsEmit("showAlert", {
        title: "FFmpeg Not Found",
        message: "FFmpeg is required for certain features. Would you like to download it now?",
        actions: [
          {
            label: "Download",
            onClick: async () => {
              // This logic is moved from the old toast action.
              // We can still use toast for in-progress/success feedback.
              toast.info("Downloading FFmpeg...");
              try {
                await DownloadFFmpeg();
                toast.success("FFmpeg downloaded successfully!");
                setFFmpegReady(true);
              } catch (err) {
                toast.error("Failed to download FFmpeg: " + err);
                setFFmpegReady(false);
              }
            },
          },
        ],
      });
      return;
    }

    //const loadingToastId = toast.loading("Syncing with DaVinci Resolve…");
    setBusy(true);

    const conditionalSetProjectData = async (
      newData: main.ProjectDataPayload | null
    ) => {
      if (newData) {
        // extract the timecode
        const timecode = Timecode(
          newData.timeline.curr_timecode,
          newData.timeline.fps as FRAMERATE
        );
        setTimecode(timecode);

        // remove the curr timecode from it to not trigger unnecessary re-renders
        newData.timeline.curr_timecode = "";
      }
      if (!deepEqual(projectData, newData)) {
        // Using fast-deep-equal
        setProjectData(newData);

        setHasProjectData(!!newData);

        if (!newData) return
        await Promise.all([
          ProcessProjectAudio(newData),
          MixdownCompoundClips(newData)
        ]);
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
        // toast.dismiss(loadingToastId);
      } else if (response && response.status !== "success") {
        console.error(
          "Sync failed (Python reported error, no global alert by Go):",
          response.message
        );
        setProjectData(null);
        setHasProjectData(false);
        // toast.error("Sync failed", {
        //   id: loadingToastId,
        //   description: response.message || "An error occurred during sync.",
        //   duration: 5000,
        // });
        setBusy(false);
      } else if (response && response.status === "success") {
        await conditionalSetProjectData(response.data);
        // toast.success("Synced with DaVinci Resolve", {
        //   id: loadingToastId,
        //   duration: 1500,
        // });
        setBusy(false);
      } else {
        console.error(
          "SyncWithDavinci: Unexpected response structure from Go",
          response
        );
        setProjectData(null);
        setHasProjectData(false);
        // toast.error("Sync failed: Unexpected response format", {
        //   id: loadingToastId,
        //   duration: 5000,
        // });
        setBusy(false);
      }
    } catch (err: any) {
      console.error("Error calling SyncWithDavinci or Go-level error:", err);
      setProjectData(null);
      setHasProjectData(false);

      if (err && err.alertIssued) {
        //toast.dismiss(loadingToastId);
      } else {
        const errorMessage =
          err?.message ||
          (typeof err === "string" ? err : "An unknown error occurred.");
        // toast.error("Sync Error", {
        //   id: loadingToastId,
        //   description: `${errorMessage}`,
        //   duration: 5000,
        // });
      }
      setBusy(false);
    }
  };

  const handleSyncRef = useRef(handleSync);

  useEffect(() => {
    handleSyncRef.current = handleSync;
  }, [handleSync]);

  useEffect(() => {
    console.count("ffmpegReady useEffect ran");
    // Don't do anything until the initial status check is complete.
    if (ffmpegReady === null) {
      return;
    }

    // This condition elegantly handles two scenarios:
    // 1. The initial check finds FFmpeg is ready (null -> true).
    // 2. The user downloads FFmpeg (false -> true).
    if (ffmpegReady === true && prevFfmpegReady !== true) {
      console.log("FFmpeg is ready, calling handleSync (via ref).");
      handleSyncRef.current();
    }
    // This handles the case where the initial check finds FFmpeg is NOT ready.
    else if (ffmpegReady === false && prevFfmpegReady === null) {
      console.log("Initial FFmpeg check failed, calling handleSync (via ref) to show alert.");
      handleSyncRef.current();
    }
  }, [ffmpegReady, prevFfmpegReady]);

  const initialInitDone = useRef(false); // Ref to track if the effect has run


  useEffect(() => {
    const hasBlur = supportsRealBackdrop();
    document.body.classList.add(hasBlur ? "has-blur" : "no-blur");
    initializeProgressListeners()
  }, []);


  useEffect(() => {
    const getInitialServerInfo = async () => {
      if (initialInitDone.current) return;
      console.log("App.tsx: Attempting to get Go HTTP server port...");
      try {
        const port = await GetGoServerPort();

        if (port && port > 0) {
          console.log("App.tsx: HTTP Server Port received:", port);
          setHttpPort(port); // This will trigger a re-render

          const isFfmpegReady = await GetFFmpegStatus();
          setFFmpegReady(isFfmpegReady);
          console.log("is ffmpeg ready: ", isFfmpegReady)

          if (isFfmpegReady) {
            console.log("FFmpeg is initially ready, calling handleSync.");
            handleSyncRef.current();
          } else {
            console.log("no ffmpeg!");
            EventsEmit("showAlert", {
              title: "FFmpeg Not Found",
              message: "FFmpeg is required for certain features. Would you like to download it now?",
              actions: [
                {
                  label: "Download",
                  onClick: async () => {
                    toast.info("Downloading FFmpeg...");
                    try {
                      await DownloadFFmpeg();
                      toast.success("FFmpeg downloaded successfully!");
                      setFFmpegReady(true);
                    } catch (err) {
                      toast.error("Failed to download FFmpeg: " + err);
                      setFFmpegReady(false);
                    }
                  },
                },
              ],
            });
          }
          const pyReady = await GetPythonReadyStatus();
          console.log("App.tsx: Python ready status:", pyReady);

        } else {
          console.error(
            "App.tsx: GetGoServerPort() returned an invalid or zero port:",
            port
          );
          setHttpPort(null);
          setCurrentClipId(null);
        }

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



  const syncTimeoutRef = useRef<number | null>(null);
  const syncMouseUpListenerRef = useRef<(() => void) | null>(null);

  // Helper to cancel any scheduled sync operation.
  // This is useful on blur or unmount.
  const cancelPendingSync = () => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
    }
    if (syncMouseUpListenerRef.current) {
      window.removeEventListener('mouseup', syncMouseUpListenerRef.current, { capture: true });
      syncMouseUpListenerRef.current = null;
    }
  };

  useEffect(() => {
    if (!isBusy && pendingSelection) {
      setCurrentClipId(pendingSelection);
      console.log("Applying pending selection:", pendingSelection);
      setPendingSelection(null);
    }
  }, [isBusy, pendingSelection, setCurrentClipId]);

  useEffect(() => {
    if (!isBusy && pendingRemoveSilences) {
      console.log("Executing pending Remove Silences action.");
      // Trigger the actual action here
      handleRemoveSilencesAction();
      setPendingRemoveSilences(false);
    }
  }, [isBusy, pendingRemoveSilences]);

  const handleRemoveSilencesAction = async () => {
    if (!projectData) {
      console.error("Cannot run Remove Silences: projectData is null.");
      return;
    }
    // This logic is duplicated from PythonRunner.tsx's handleClick
    // It's necessary here because App.tsx is responsible for triggering the action
    // after a pending state.
    const clipStoreState = useClipStore.getState();
    const timelineItems = projectData?.timeline?.audio_track_items ?? [];
    const currentClipParams = deriveAllClipDetectionParams(timelineItems, clipStoreState);
    const keepSilence = useGlobalStore.getState().keepSilence;

    try {
      const dataToSend = await prepareProjectDataWithEdits(
        projectData,
        currentClipParams,
        keepSilence,
        getDefaultDetectionParams()
      );

      if (dataToSend) {
        console.log("Executing pending: Making final timeline...");
        const makeNewTimeline = useGlobalStore.getState().makeNewTimeline;
        const response = await MakeFinalTimeline(dataToSend, makeNewTimeline);
        if (!response || response.status === "error") {
          const errMessage = response?.message || "Unknown error occurred in timeline generation.";
          console.error("Executing pending: Timeline generation failed:", errMessage);
          // TODO: Add error toast
          return;
        }
        console.log("Executing pending: 'HushCut Silences' process finished successfully.");
        // TODO: Add success toast
      }
    } catch (error) {
      console.error("Executing pending: Error during 'HushCut Silences' process:", error);
      // TODO: Add error toast
    }
  };

  const handleFocusWithDragDelay = () => {
    // First, cancel any previously pending sync, just in case.
    cancelPendingSync();

    const executeSyncAndCleanup = () => {
      // Ensure cleanup happens, even if called directly by the timeout.
      cancelPendingSync();

      console.log("Drag-friendly delay is over. Executing sync.");
      handleSync();
    };

    // Store the listener function in a ref so it can be removed by other functions.
    syncMouseUpListenerRef.current = executeSyncAndCleanup;

    console.log("Window focused. Waiting for mouseup or a short timeout to sync.");

    // Add the listener for the mouse release. We manage removal manually.
    window.addEventListener('mouseup', syncMouseUpListenerRef.current, { capture: true });

    // Set a fallback timeout for non-mouse focus (e.g., Alt+Tab).
    syncTimeoutRef.current = setTimeout(() => {
      console.log("Sync fallback timeout triggered.");
      // Call the main handler, which will sync and clean up.
      executeSyncAndCleanup();
    }, 1200);
  };

  const handleBlur = () => {
    console.log("Tab is blurred, cancelling any pending sync operation.");
    cancelPendingSync();
  };

  useWindowFocus(
    handleFocusWithDragDelay,
    handleBlur,
    { fireOnMount: false, throttleMs: 500 }
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingSync();
    };
  }, []);


  const handleAudioClipSelection = (selectedItemId: string) => {
    if (isBusy) {
      setPendingSelection(selectedItemId);
      console.log("App is busy, pending selection set to:", selectedItemId);
      return;
    }
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
        className="pt-3 bg-[#1b1b1f] border-t-0"
        style={{
          marginTop: titleBarHeight,
          height: `calc(100vh - ${titleBarHeight})`,
          overflowY: "auto", // Make this div scrollable
        }}
      >
        <header className="flex items-center justify-between"></header>
        <main className="flex flex-col max-w-screen select-none h-full">
          {currentActiveClip?.id && httpPort && (
            <div className="flex-shrink-0 px-3">
              <FileSelector
                audioItems={projectData?.timeline.audio_track_items}
                currentFileId={currentClipId}
                onFileChange={handleAudioClipSelection}
                fps={projectData?.timeline.fps}
                disabled={
                  !httpPort ||
                  !projectData?.timeline?.audio_track_items ||
                  projectData.timeline.audio_track_items.length === 0
                }
                className="w-full mt-1 overflow-visible"
              />
            </div>
          )}
          <div className="flex flex-col flex-1 space-y-1 px-3 flex-grow min-h-0 py-2">
            <div className="flex flex-row space-x-1 items-start flex-1 min-h-[180px] max-h-[600px]">
              {currentActiveClip &&
                projectData?.timeline && (
                  <div className="flex w-min h-full">
                    <ThresholdControl key={currentClipId} />
                    <PeakMeter />
                  </div>
                )}

              <div className="flex flex-col space-y-2 w-full min-w-0 p-0 overflow-visible h-full">
                {!projectData || !currentClipId || !httpPort ? (
                  <div className="w-full h-full flex items-center justify-center bg-[#212126] rounded-sm">
                    {!projectData ? (
                      <p className="text-gray-500">No active timeline.</p>
                    ) : (
                      <p className="text-gray-500">No audio clips in timeline.</p>
                    )}

                  </div>
                ) : (
                  currentActiveClip &&
                  projectData?.timeline && (
                    <WaveformPlayer
                      key={currentActiveClip.id}
                      activeClip={currentActiveClip}
                      projectFrameRate={projectData.timeline.fps}
                      httpPort={httpPort}
                    />
                  )
                )}
              </div>
            </div>
            <div className="w-full px-1 pb-5 bg-[#212126] rounded-2xl rounded-tr-[3px] border-1 shadow-xl h-min flex flex-col">
              <div className="p-2 md:p-5 flex flex-wrap items-start gap-x-10 gap-y-2 justify-between flex-grow">
                <div className="flex flex-wrap gap-x-4 gap-y-2 flex-1 max-w-2xl">
                  <SilenceControls key={currentClipId} />
                </div>
                {projectData && projectData.timeline?.audio_track_items?.length > 0 && (
                  <div className="pt-5 pr-5 pl-5 [@media(width>=45rem)]:pl-0 flex gap-4 [@media(width>=45rem)]:w-min [@media(width>=45rem)]:flex-col-reverse [@media(width>=45rem)]:justify-start w-full justify-between">
                    <DavinciSettings />
                    <RemoveSilencesButton
                      projectData={projectData}
                      defaultDetectionParams={getDefaultDetectionParams()}
                      onPendingAction={() => setPendingRemoveSilences(true)}
                    />
                    <SliderZag />
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}


interface FinalTimelineProps {
  open: boolean;
  progressPercentage: number | null;
  message: string;
  totalTime: number
  onOpenChange: (open: boolean) => void; // <-- Add this to your interface
}

export function FinalTimelineProgress({ open, progressPercentage, message, totalTime, onOpenChange }: FinalTimelineProps) {
  const displayMessage = progressPercentage === 100 ? "Done" : message;

  const [internalOpen, setInternalOpen] = useState(false);
  const [dialogOpacity, setDialogOpacity] = useState(1);

  useEffect(() => {
    if (open) {
      setInternalOpen(true);
      setDialogOpacity(1);
    } else {
      setDialogOpacity(0);
      const fadeOutTimer = setTimeout(() => {
        setInternalOpen(false);
      }, 150); // Match transition duration
      return () => clearTimeout(fadeOutTimer);
    }
  }, [open]);

  if (!internalOpen) return null;

  return (
    <Drawer open={internalOpen} onOpenChange={onOpenChange}>
      <DrawerContent
        className="maybe-glass"
        style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
        disableRadixAnimations={dialogOpacity === 0}
      >
        <div className="max-w-full p-4 px-8 md:p-12 space-y-4 sm:space-y-6 md:space-y-8">
          <DrawerTitle className="text-2xl sm:text-4xl md:text-5xl mt-12 font-medium">{displayMessage}</DrawerTitle>
          {Number.isFinite(progressPercentage) && (
            <Progress value={progressPercentage} className="h-0.5" />
          )}
          <DrawerDescription>
            {progressPercentage === 100 && (
              <>
                Completed in: <span className="text-stone-200 mr-[2px]">{totalTime.toFixed(2)}</span><span>s</span>
              </>
            )}

            {!progressPercentage || progressPercentage < 100 && (
              <>
                Please wait.
              </>
            )}

          </DrawerDescription>


          <DrawerFooter className="flex flex-col sm:flex-row sm:justify-start gap-3 pt-6 px-0">
            {progressPercentage === 100 && (
              <Button
                onClick={() => onOpenChange(false)}
                className="rounded-2xl text-base px-6 py-2 shadow transition-colors"
              >
                Continue
              </Button>
            )}

            <DrawerClose asChild onClick={CloseApp}>
              <Button
                variant="outline"
                className="rounded-2xl text-base px-6 py-2 border-muted text-muted-foreground hover:bg-muted/20 transition-colors"
              >
                Exit
              </Button>
            </DrawerClose>
          </DrawerFooter>



        </div>
      </DrawerContent>
    </Drawer>
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
  const isInfoDialogOpen = useUiStore((state) => state.isInfoDialogOpen);
  const setInfoDialogOpen = useUiStore((state) => state.setInfoDialogOpen);
  const isSettingsDialogOpen = useUiStore((state) => state.isSettingsDialogOpen);
  const setSettingsDialogOpen = useUiStore((state) => state.setSettingsDialogOpen);

  const [showFinalProgress, setShowFinalProgress] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");


  const timeStartedRef = useRef<number | null>(null);
  const timeFinishedRef = useRef<number | null>(null);
  const [totalTime, setTotalTime] = useState(0);

  useEffect(() => {
    const off1 = EventsOn("taskProgressUpdate", (data: { message: string; progress: number }) => {
      console.log("taskProgressUpdate", data);

      if (data.progress != null) {
        setProgress(prev => {
          if (prev === null) return data.progress;
          return data.progress < prev ? prev : data.progress;
        });
      }

      if (data.message) setMessage(data.message);
    });

    const off2 = EventsOn("showFinalTimelineProgress", () => {
      if (showFinalProgress) return;
      console.log("showFinalTimelineProgress");
      timeStartedRef.current = Date.now();
      setProgress(0);
      setMessage("Preparing");
      setShowFinalProgress(true);
    });

    const off3 = EventsOn("finished", () => {
      timeFinishedRef.current = Date.now();
      if (timeStartedRef.current) {
        const elapsed = (timeFinishedRef.current! - timeStartedRef.current!) / 1000;
        setTotalTime(elapsed);
      }
      setProgress(100);
      setTimeout(() => {
        setProgress(100);
      }, 50);
    });


    const off4 = EventsOn("ffmpeg:installed", () => {
      toast.success("FFmpeg downloaded successfully!");
    });

    return () => {
      off1();
      off2();
      off3();
      off4();
    };
  }, []);

  return (
    <>
      <ClientPortal targetId="overlays">
        <GlobalAlertDialog />
        <FinalTimelineProgress
          open={showFinalProgress}
          progressPercentage={progress}
          message={message}
          totalTime={totalTime}
          onOpenChange={setShowFinalProgress}
        />
        <InfoDialog open={isInfoDialogOpen} onOpenChange={setInfoDialogOpen} />
        <SettingsDialog open={isSettingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
        <Toaster />
      </ClientPortal>

      <ClientPortal targetId="title-bar-root">{MemoizedTitleBar}</ClientPortal>
      <AppContent />
    </>
  );
}