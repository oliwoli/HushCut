import { useEffect, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Toaster } from "./components/ui/sonner";
import { Label } from "@/components/ui/label";
import { LogSlider } from "./components/ui/volumeSlider";
import { RotateCcw, Link, Unlink, Ellipsis, XIcon } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { clamp, cn } from "@/lib/utils";
import { GetGoServerPort, SyncWithDavinci } from "@wails/go/main/App";
import { GetPythonReadyStatus } from "@wails/go/main/App";
import { EventsOn } from "@wails/runtime/runtime";
import { main } from "@wails/go/models";

import WaveformPlayer from "./components/audio/waveform";
import RemoveSilencesButton from "./lib/PythonRunner";
import { CloseApp } from "@wails/go/main/App";
import { ActiveClip, DetectionParams } from "./types";
import { useSilenceData } from "./hooks/useSilenceData";
import { useWindowFocus } from "./hooks/hooks";
import FileSelector from "./components/ui/fileSelector";

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

export default function App() {
  const [httpPort, setHttpPort] = useState<Number | null>(null);
  const [currentActiveClip, setCurrentActiveClip] = useState<ActiveClip | null>(
    null
  ); // Initialize as null
  const [projectData, setProjectData] =
    useState<main.ProjectDataPayload | null>(null);

  const [detectionParams, setDetectionParams] =
    useState<DetectionParams | null>(null);

  const { silenceData, isLoading, error, refetch } = useSilenceData(
    currentActiveClip,
    detectionParams
  );

  const handleSync = () => {
    toast.promise(SyncWithDavinci(), {
      loading: "Syncing with DaVinci Resolve…",
      success: (response: main.PythonCommandResponse) => {
        console.log("SyncWithDavinci success:", response);
        setProjectData(response.data);
        return "Synced with DaVinci Resolve";
      },
      error: (err: any) => {
        console.error("SyncWithDavinci error:", err);
        toast.error(
          err ? `Sync failed. ${err.message || err}` : "Sync failed."
        );
        setProjectData(null);
        return "Sync failed.";
      },
    });
  };

  const [alertOpen, setAlertOpen] = useState(false);
  const [alertData, setAlertData] = useState({
    title: "",
    message: "",
    severity: "info",
  });

  useEffect(() => {
    EventsOn("showAlert", (data) => {
      console.log("Event: showAlert", data);
      setAlertData({
        title: data.title || "No title",
        message: data.message || "No message",
        severity: data.severity || "info",
      });
      setAlertOpen(true);
    });
  }, []);

  useEffect(() => {
    const getInitialServerInfo = async () => {
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

        // initial sync with python
        await SyncWithDavinci();
      } catch (err) {
        console.error("App.tsx: Error during initial server info fetch:", err);
        setHttpPort(null);
        setCurrentActiveClip(null);
        // Optionally, inform the user
      }
    };
    getInitialServerInfo();
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
      // if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []); // Empty dependency array ensures this runs once on mount

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

  const handleAudioFileSelection = (selectedItemId: string) => {
    if (
      !projectData?.timeline?.audio_track_items ||
      !httpPort ||
      !selectedItemId
    ) {
      console.warn(
        "Cannot handle file selection: Missing data, port, or selectedItemId"
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

  const DEFAULT_THRESHOLD = -30;
  const DEFAULT_MIN_DURATION = 1.0;
  const MIN_DURATION_LIMIT = 0.01;
  const DEFAULT_PADDING = 0.25;

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [minDuration, setMinDurationRaw] = useState(DEFAULT_MIN_DURATION);

  const setMinDuration = (value: number) => {
    setMinDurationRaw(clamp(value, MIN_DURATION_LIMIT));
  };

  const [paddingLeft, setPaddingLeft] = useState(DEFAULT_PADDING);
  const [paddingRight, setPaddingRight] = useState(DEFAULT_PADDING);
  //const [makeNewTimeline, setMakeNewTimeline] = useState(false);
  const [paddingLocked, setPaddingLinked] = useState(true);

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

  useEffect(() => {
    // Update detectionParams when individual parameter states change
    setDetectionParams({
      loudnessThreshold: threshold.toString() + "dB",
      minSilenceDurationSeconds: minDuration.toString(),
      paddingLeftSeconds: paddingLeft,
      paddingRightSeconds: paddingRight,
    });
  }, [threshold, minDuration, paddingLeft, paddingRight]);

  return (
    <>
      {/* TITLE BAR */}
      <ContextMenu>
        <ContextMenuTrigger>
          <div className="fixed top-0 select-none left-0 w-full draggable h-9 border-1 border-zinc-950 bg-[#212126] flex items-center justify-between px-1 z-50">
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
          <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{alertData.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {alertData.message}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction onClick={() => setAlertOpen(false)}>
                  Continue
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {projectData?.files && currentActiveClip?.id && (
            <FileSelector
              audioItems={projectData?.timeline?.audio_track_items}
              currentFileId={currentActiveClip?.id || null}
              onFileChange={handleAudioFileSelection}
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
              <div className="flex flex-col space-y-2 w-full min-w-0 p-2 overflow-visible">
                {httpPort && currentActiveClip?.processedFileName && (
                  <WaveformPlayer
                    audioUrl={`http://localhost:${httpPort}/${currentActiveClip?.processedFileName}.wav`}
                    silenceData={silenceData}
                    threshold={threshold}
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
                  {/* test
                  <audio
                    src={`http://localhost:${audioServerPort}/preview-render.wav`}
                    controls
                  /> */}

                  <div className="items-center space-y-2 mt-4">
                    {/* <div className="flex items-center space-x-2">
                      <Checkbox
                        checked={makeNewTimeline}
                        onCheckedChange={(checked) =>
                          setMakeNewTimeline(checked === true)
                        }
                      />
                      <Label className="text-base">Make new timeline</Label>
                    </div> */}
                    {projectData && detectionParams && (
                      <RemoveSilencesButton
                        projectData={projectData}
                        keepSilenceSegments={false}
                        detectionParams={detectionParams}
                      />
                    )}
                  </div>
                  <Toaster
                    toastOptions={{
                      classNames: {
                        toast: "min-w-[10px] w-auto bg-red-400", // set your desired min and max width here
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
