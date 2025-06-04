import { useEffect, useMemo, useRef, useState } from "react";
import deepEqual from "fast-deep-equal";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Toaster } from "./components/ui/sonner";
import { Label } from "@/components/ui/label";
import { LogSlider } from "./components/ui-custom/volumeSlider";
import { RotateCcw, Link, Unlink, Ellipsis, XIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { clamp, cn } from "@/lib/utils";
import {
  GetGoServerPort,
  GetLogarithmicWaveform,
  SyncWithDavinci,
} from "@wails/go/main/App";
import { GetPythonReadyStatus } from "@wails/go/main/App";
import { EventsOn } from "@wails/runtime";
import { main } from "@wails/go/models";

import WaveformPlayer from "./components/audio/waveform";
import RemoveSilencesButton from "./lib/PythonRunner";
import { CloseApp } from "@wails/go/main/App";
import { ActiveClip, DetectionParams } from "./types";
import { useSilenceData } from "./hooks/useSilenceData";
import { useWindowFocus } from "./hooks/hooks";
import FileSelector from "./components/ui-custom/fileSelector";
import GlobalAlertDialog from "./components/ui-custom/GlobalAlertDialog";

EventsOn("showToast", (data) => {
  console.log("Event: showToast", data);
  // Simple alert for now, TODO: use nicer shadcn component
  alert(`Toast [${data.toastType || "info"}]: ${data.message}`);
});

EventsOn("projectDataReceived", (projectData: main.ProjectDataPayload) => {
  console.log("Event: projectDataReceived", projectData);
});

// Reusable reset button with dimmed default state and hover transition
function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className="text-zinc-500 hover:text-zinc-300"
    >
      <RotateCcw className="h-4 w-4" />
    </Button>
  );
}

const DEFAULT_THRESHOLD = -30;
const DEFAULT_MIN_DURATION = 1.0;
const MIN_DURATION_LIMIT = 0.01;
const DEFAULT_PADDING = 0.25;

const getDefaultDetectionParams = (): DetectionParams => ({
  loudnessThreshold: DEFAULT_THRESHOLD,
  minSilenceDurationSeconds: DEFAULT_MIN_DURATION,
  paddingLeftSeconds: DEFAULT_PADDING,
  paddingRightSeconds: DEFAULT_PADDING,
  // If you want to store paddingLocked per-clip, add it here:
  // paddingLocked: true,
});

export default function App() {
  const [httpPort, setHttpPort] = useState<Number | null>(null);
  const [currentActiveClip, setCurrentActiveClip] = useState<ActiveClip | null>(
    null
  );
  const [projectData, setProjectData] =
    useState<main.ProjectDataPayload | null>(null);

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [minDuration, setMinDurationRaw] = useState(DEFAULT_MIN_DURATION);

  const setMinDuration = (value: number) => {
    setMinDurationRaw(clamp(value, MIN_DURATION_LIMIT));
  };

  const [paddingLeft, setPaddingLeft] = useState(DEFAULT_PADDING);
  const [paddingRight, setPaddingRight] = useState(DEFAULT_PADDING);
  //const [makeNewTimeline, setMakeNewTimeline] = useState(false);
  const [paddingLocked, setPaddingLinked] = useState(true);

  const [allClipDetectionParams, setAllClipDetectionParams] = useState<
    Record<string, DetectionParams>
  >({});

  const currentClipEffectiveParams = useMemo<DetectionParams | null>(() => {
    if (currentActiveClip?.id) {
      // If params for this clip exist, use them
      if (allClipDetectionParams[currentActiveClip.id]) {
        return allClipDetectionParams[currentActiveClip.id];
      }
      // If not, it means the clip was just selected and UI defaults are active
      // We can return a temporary object based on current UI state,
      // which will soon be saved by the effect below.
      return {
        loudnessThreshold: threshold,
        minSilenceDurationSeconds: minDuration,
        paddingLeftSeconds: paddingLeft,
        paddingRightSeconds: paddingRight,
      };
    }
    return getDefaultDetectionParams(); // Or null if you prefer to handle no clip selected differently
  }, [
    currentActiveClip?.id,
    allClipDetectionParams,
    threshold,
    minDuration,
    paddingLeft,
    paddingRight,
  ]);

  const { silenceData } = useSilenceData(
    currentActiveClip,
    currentClipEffectiveParams,
    projectData?.timeline?.fps || null
  );

  const [activeClipSegmentPeakData, setActiveClipSegmentPeakData] =
    useState<main.PrecomputedWaveformData | null>(null);

  // This state will hold the URL for the dynamically rendered clip segment
  const [cutAudioSegmentUrl, setCutAudioSegmentUrl] = useState<string | null>(
    null
  );
  // Effect to prepare data for WaveformPlayer when currentActiveClip changes
  useEffect(() => {
    if (
      currentActiveClip &&
      projectData?.timeline?.fps &&
      httpPort &&
      typeof currentActiveClip.sourceStartFrame === "number" &&
      typeof currentActiveClip.sourceEndFrame === "number"
    ) {
      const fps = projectData.timeline.fps;
      const clipStartSeconds = currentActiveClip.sourceStartFrame / fps;
      const clipEndSeconds = currentActiveClip.sourceEndFrame / fps;

      if (clipEndSeconds <= clipStartSeconds) {
        console.warn(
          "App.tsx: Clip end time is before or at start time. Not fetching segment data.",
          currentActiveClip
        );
        setActiveClipSegmentPeakData(null);
        setCutAudioSegmentUrl(null);
        return;
      }

      // 1. Construct the URL for the cut audio segment
      const newCutAudioUrl = `http://localhost:${httpPort}/render_clip?file=${encodeURIComponent(
        currentActiveClip.processedFileName + ".wav"
      )}&start=${clipStartSeconds.toFixed(3)}&end=${clipEndSeconds.toFixed(3)}`;
      setCutAudioSegmentUrl(newCutAudioUrl);
      console.log("App.tsx: Constructed cutAudioUrl:", newCutAudioUrl);

      // 2. Fetch peak data for this specific segment
      let isCancelled = false;
      const fetchClipPeaks = async () => {
        console.log(
          "App.tsx: Fetching peak data for clip segment:",
          currentActiveClip.processedFileName,
          clipStartSeconds,
          clipEndSeconds
        );
        // setIsLoading(true); // You might have a more general loading state
        try {
          const peakDataForSegment = await GetLogarithmicWaveform(
            currentActiveClip.processedFileName + ".wav", // Pass the base filename
            256, // samplesPerPixel - adjust as needed
            -60.0, // dbRange - adjust as needed
            clipStartSeconds,
            clipEndSeconds
          );

          if (!isCancelled) {
            if (
              peakDataForSegment &&
              peakDataForSegment.peaks &&
              peakDataForSegment.peaks.length > 0 &&
              peakDataForSegment.duration > 0
            ) {
              setActiveClipSegmentPeakData(peakDataForSegment);
              console.log(
                "App.tsx: Peak data for clip segment fetched, duration:",
                peakDataForSegment.duration.toFixed(2)
              );
            } else {
              console.warn(
                "App.tsx: Received invalid peak data for segment",
                currentActiveClip.processedFileName,
                peakDataForSegment
              );
              setActiveClipSegmentPeakData(null);
            }
          }
        } catch (e) {
          if (!isCancelled) {
            setActiveClipSegmentPeakData(null);
          }
          console.error(
            "App.tsx: Error fetching peak data for segment",
            currentActiveClip.processedFileName,
            e
          );
        } finally {
          // if (!isCancelled) setIsLoading(false);
        }
      };

      fetchClipPeaks();
      return () => {
        isCancelled = true;
      };
    } else {
      // Reset if no valid active clip or necessary data
      setActiveClipSegmentPeakData(null);
      setCutAudioSegmentUrl(null);
    }
  }, [currentActiveClip, projectData, httpPort]);

  const handleSync = async () => {
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
      } else if (response && response.status === "success") {
        conditionalSetProjectData(response.data);
        toast.success("Synced with DaVinci Resolve", {
          id: loadingToastId,
          duration: 1500,
        });
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
          setCurrentActiveClip(null);
          // Optionally, inform the user that the audio server isn't available
        }

        await handleSync();
      } catch (err) {
        console.error("App.tsx: Error during initial server info fetch:", err);
        setHttpPort(null);
        setCurrentActiveClip(null);
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

  // set active file
  useEffect(() => {
    const init = async () => {
      if (!httpPort) {
        const port = await GetGoServerPort();
        setHttpPort(port);
        if (currentActiveClip !== null) setCurrentActiveClip(null);
        console.log("No httpPort, setting currentActiveFile to null.");
      }
    };
    init();

    if (!httpPort) return;

    let newActiveFileTarget: ActiveClip | null = null;
    const audioTrackItems = projectData?.timeline?.audio_track_items;

    if (!audioTrackItems || audioTrackItems.length === 0) {
      setCurrentActiveClip(null);
      return;
    }

    const sortedAudioItems = [...audioTrackItems].sort((a, b) => {
      if (a.track_index !== b.track_index) return a.track_index - b.track_index;
      if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
      return a.end_frame - b.end_frame;
    });

    let TId = currentActiveClip?.id;
    if (currentActiveClip && TId !== "initial-preview") {
      const currentItemInNewList = sortedAudioItems.find(
        (item) => (item.id || item.processed_file_name) === TId
      );
      if (currentItemInNewList) {
        newActiveFileTarget = createActiveFileFromTimelineItem(
          currentItemInNewList,
          httpPort
        );
      }
    }

    if (!newActiveFileTarget) {
      // If no current valid selection, or if it was initial
      for (const item of sortedAudioItems) {
        // Try to pick the first valid item
        newActiveFileTarget = createActiveFileFromTimelineItem(item, httpPort);
        if (newActiveFileTarget) break; // Found a valid one
      }
    }

    if (
      currentActiveClip?.id !== newActiveFileTarget?.id ||
      currentActiveClip?.previewUrl !== newActiveFileTarget?.previewUrl
    ) {
      setCurrentActiveClip(newActiveFileTarget);
      console.log(
        "useEffect: currentActiveFile updated to:",
        newActiveFileTarget
      );
    }
  }, [httpPort, projectData, currentActiveClip?.id]);

  const handleAudioClipSelection = (selectedItemId: string) => {
    if (
      !projectData?.timeline?.audio_track_items ||
      !httpPort ||
      !selectedItemId
    ) {
      console.warn(
        "Cannot handle clip selection: Missing data, port, or selectedItemId"
      );
      return;
    }

    const selectedItem = projectData.timeline.audio_track_items.find(
      (item) => (item.id || item.processed_file_name) === selectedItemId
    );

    if (selectedItem) {
      const newActiveFile = createActiveFileFromTimelineItem(
        selectedItem,
        httpPort
      );
      if (newActiveFile) {
        setCurrentActiveClip(newActiveFile);
        console.log(
          "FileSelector onFileChange: currentActiveFile set to:",
          newActiveFile
        );
      } else {
        console.warn(
          "Failed to create ActiveFile from selected TimelineItem:",
          selectedItem
        );
      }
    } else {
      console.warn("Selected TimelineItem not found for ID:", selectedItemId);
    }
  };

  // EFFECT: Load parameters into UI when currentActiveClip changes
  useEffect(() => {
    if (currentActiveClip?.id) {
      const paramsForCurrentClip = allClipDetectionParams[currentActiveClip.id];
      if (paramsForCurrentClip) {
        // Load stored params into UI
        setThreshold(paramsForCurrentClip.loudnessThreshold);
        setMinDurationRaw(paramsForCurrentClip.minSilenceDurationSeconds); // Use Raw to bypass clamp temporarily if needed, though direct set is fine
        setPaddingLeft(paramsForCurrentClip.paddingLeftSeconds);
        setPaddingRight(paramsForCurrentClip.paddingRightSeconds);
        // If paddingLocked is stored per clip:
        // setPaddingLinked(paramsForCurrentClip.paddingLocked !== undefined ? paramsForCurrentClip.paddingLocked : true);
      } else {
        // No params stored for this clip yet, reset UI to defaults
        // The next effect will then save these defaults for this new clip.
        setThreshold(DEFAULT_THRESHOLD);
        setMinDurationRaw(DEFAULT_MIN_DURATION);
        setPaddingLeft(DEFAULT_PADDING);
        setPaddingRight(DEFAULT_PADDING);
        setPaddingLinked(true); // Reset lock state too
      }
    } else {
      // No active clip, reset UI to defaults (optional, based on desired UX)
      setThreshold(DEFAULT_THRESHOLD);
      setMinDurationRaw(DEFAULT_MIN_DURATION);
      setPaddingLeft(DEFAULT_PADDING);
      setPaddingRight(DEFAULT_PADDING);
      setPaddingLinked(true);
    }
  }, [currentActiveClip?.id]);

  // EFFECT: Save UI parameters to allClipDetectionParams when they change
  useEffect(() => {
    if (currentActiveClip?.id) {
      const newParamsForCurrentClip: DetectionParams = {
        loudnessThreshold: threshold,
        minSilenceDurationSeconds: minDuration, // minDuration is already clamped
        paddingLeftSeconds: paddingLeft,
        paddingRightSeconds: paddingRight,
        // If paddingLocked is stored per clip:
        // paddingLocked: paddingLocked,
      };

      // Only update if they are actually different, using deepEqual
      if (
        !deepEqual(
          allClipDetectionParams[currentActiveClip.id],
          newParamsForCurrentClip
        )
      ) {
        setAllClipDetectionParams((prevParams) => ({
          ...prevParams,
          [currentActiveClip.id as string]: newParamsForCurrentClip, // Ensure id is string if that's the key type
        }));
      }
    }
    // This effect runs when any UI parameter changes OR when the current clip changes
    // (to ensure defaults are saved for a newly selected clip if not already present).
  }, [
    threshold,
    minDuration,
    paddingLeft,
    paddingRight,
    paddingLocked,
    currentActiveClip?.id,
    allClipDetectionParams,
  ]);

  const handlePaddingChange = (side: "left" | "right", value: number) => {
    if (paddingLocked) {
      setPaddingLeft(value);
      setPaddingRight(value);
    } else {
      side === "left" ? setPaddingLeft(value) : setPaddingRight(value);
    }
  };

  const resetThreshold = () => setThreshold(DEFAULT_THRESHOLD);
  const resetMinDuration = () => setMinDuration(DEFAULT_MIN_DURATION);
  const resetPadding = () => {
    setPaddingLeft(DEFAULT_PADDING);
    setPaddingRight(DEFAULT_PADDING);
    setPaddingLinked(true);
  };

  const titleBarHeight = "2.35rem";

  return (
    <>
      {/* TITLE BAR */}
      <ContextMenu>
        <ContextMenuTrigger>
          <div className="fixed top-0 select-none left-0 w-full draggable h-9 border-1 border-zinc-950 bg-[#212126] flex items-center justify-between px-1 z-90">
            <Button
              size={"sm"}
              className="px-0 mx-0 bg-transparent hover:bg-transparent text-zinc-500 hover:text-white"
              onClick={CloseApp}
            >
              <XIcon className="scale-90" strokeWidth={2.5} />
            </Button>
            <h1 className="text-sm font-normal text-neutral-200">Pruner</h1>
            <div className="flex items-center space-x-2">
              <Button
                size="icon"
                className="bg-transparent hover:text-white hover:bg-transparent"
              >
                <Ellipsis className="h-8 w-8 text-xl scale-150 text-zinc-400 opacity-80 hover:text-blue-500 hover:opacity-100" />
              </Button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <ContextMenuItem inset onClick={CloseApp}>
            Close
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div
        className="p-6 pt-3 bg-[#28282e] border-1 border-t-0 border-zinc-900"
        style={{
          marginTop: titleBarHeight,
          height: `calc(100vh - ${titleBarHeight})`,
          overflowY: "auto", // Make this div scrollable
        }}
      >
        <header className="flex items-center justify-between"></header>

        <main className="flex-1 gap-8 mt-8 max-w-screen select-none">
          <GlobalAlertDialog />
          {projectData?.files && currentActiveClip?.id && (
            <FileSelector
              audioItems={projectData?.timeline?.audio_track_items}
              currentFileId={currentActiveClip?.id || null}
              onFileChange={handleAudioClipSelection}
              disabled={
                !httpPort ||
                !projectData?.timeline?.audio_track_items ||
                projectData.timeline.audio_track_items.length === 0
              }
              className="w-full md:w-1/2 lg:w-1/3" // Example responsive width
            />
          )}
          <div className="flex flex-col space-y-8">
            {/* Group Threshold, Min Duration, and Padding */}
            <div className="flex flex-row space-x-6 items-start">
              <div className="flex flex-col space-y-2 items-center">
                {" "}
                {/* Make this a flex column for its own content */}
                <LogSlider
                  defaultDb={threshold}
                  onGainChange={(gain) => setThreshold(gain)}
                  onDoubleClick={resetThreshold}
                />
                <div className="flex flex-col items-center text-center mt-1 text-base/tight">
                  <p className="text-base/tight">
                    Silence
                    <br />
                    Threshold
                  </p>
                  <span className="text-xs text-zinc-100 whitespace-nowrap font-mono tracking-tighter">
                    {threshold.toFixed(2)}{" "}
                    <span className="opacity-80">dB</span>
                  </span>
                </div>
              </div>
              <div className="flex flex-col space-y-2 w-full min-w-0 p-0 overflow-visible">
                {httpPort &&
                  cutAudioSegmentUrl &&
                  currentActiveClip &&
                  projectData &&
                  projectData.timeline &&
                  currentClipEffectiveParams && (
                    <WaveformPlayer
                      audioUrl={cutAudioSegmentUrl}
                      peakData={activeClipSegmentPeakData}
                      clipOriginalStartSeconds={
                        currentActiveClip.sourceStartFrame /
                        projectData.timeline.fps
                      }
                      silenceData={silenceData}
                      projectFrameRate={projectData.timeline.fps}
                      detectionParams={currentClipEffectiveParams}
                    />
                  )}
                <div className="space-y-2 w-full">
                  <div className="flex items-center space-x-5">
                    <Label className="font-medium w-32 flex-row-reverse">
                      Minimum Duration
                    </Label>
                    <div className="flex w-64 items-center space-x-2">
                      <Slider
                        min={0}
                        max={5}
                        step={0.001}
                        value={[minDuration]}
                        onValueChange={(vals) => setMinDuration(vals[0])}
                        className="w-full"
                      />
                      <span className="text-sm text-zinc-100">
                        {minDuration.toFixed(2)}s
                      </span>
                      <ResetButton onClick={resetMinDuration} />
                    </div>
                  </div>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex items-baseline space-x-5">
                    <Label className="font-medium w-32 text-right flex-row-reverse">
                      Padding
                    </Label>
                    <div className="flex items-start space-x-0">
                      {/* Left Padding */}
                      <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center">
                          <Slider
                            min={0}
                            max={1}
                            step={0.05}
                            value={[paddingLeft]}
                            onValueChange={(vals) =>
                              handlePaddingChange("left", vals[0])
                            }
                            className="w-32"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setPaddingLinked((l) => !l)}
                            className="text-zinc-500 hover:text-zinc-300 text-center"
                          >
                            {paddingLocked ? (
                              <Link className="h-4 w-4" />
                            ) : (
                              <Unlink className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                        <span className="text-sm text-zinc-400">
                          Left:{" "}
                          <span className="text-zinc-100">
                            {paddingLeft.toFixed(2)}s
                          </span>
                        </span>
                      </div>

                      {/* Right Padding */}
                      <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center space-x-2">
                          <Slider
                            min={0}
                            max={1}
                            step={0.05}
                            value={[paddingRight]}
                            onValueChange={(vals) =>
                              handlePaddingChange("right", vals[0])
                            }
                            className="w-32"
                          />
                          <ResetButton onClick={() => resetPadding()} />
                        </div>
                        <span className="text-sm text-zinc-400">
                          Right:{" "}
                          <span className="text-zinc-100">
                            {paddingRight.toFixed(2)}s
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col space-y-8 w-full">
                  <div className="items-center space-y-2 mt-4">
                    {projectData && currentClipEffectiveParams && (
                      <RemoveSilencesButton
                        projectData={projectData}
                        keepSilenceSegments={false}
                        allClipDetectionParams={allClipDetectionParams}
                        defaultDetectionParams={getDefaultDetectionParams()}
                      />
                    )}
                  </div>
                  <Toaster
                    position="bottom-right"
                    toastOptions={{
                      classNames: {
                        toast:
                          "min-w-[10px] w-auto bg-red-400 mt-10 z-10 absolute",
                      },
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
