import React, { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LogSlider } from "./components/ui/volumeSlider";
import { RotateCcw, Link, Unlink, Ellipsis, XIcon } from "lucide-react";

import { clamp, cn } from "@/lib/utils";
import { EventsOn } from "../wailsjs/runtime/runtime";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import WaveformPlayer from "./components/audio/waveform";
import PythonRunnerComponent from "./lib/PythonRunner";
import { CloseApp } from "../wailsjs/go/main/App";
import SilenceDataLog from "./components/audio/SilenceDataDisplay";
import { ActiveFile, DetectionParams } from "./types";
import { useSilenceData } from "./hooks/useSilenceData";

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
  const DEFAULT_THRESHOLD = -20;
  const DEFAULT_MIN_DURATION = 0.5;
  const MIN_DURATION_LIMIT = 0.01;
  const DEFAULT_PADDING = 0.0;

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [minDuration, setMinDurationRaw] = useState(DEFAULT_MIN_DURATION);

  const setMinDuration = (value: number) => {
    setMinDurationRaw(clamp(value, MIN_DURATION_LIMIT));
  };

  const [paddingLeft, setPaddingLeft] = useState(DEFAULT_PADDING);
  const [paddingRight, setPaddingRight] = useState(DEFAULT_PADDING);
  const [makeNewTimeline, setMakeNewTimeline] = useState(false);
  const [paddingLocked, setPaddingLinked] = useState(true);

  const [pythonLogs, setPythonLogs] = useState([]);
  const [scriptStatus, setScriptStatus] = useState("");

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

  const [windowMenuVisible, setWindowMenuVisible] = useState(false);

  const handleWindowMenuToggle = () => {
    setWindowMenuVisible((prev) => !prev);
  };

  const titleBarHeight = "2.35rem";

  const [detectionParams, setDetectionParams] =
    useState<DetectionParams | null>(null);

  useEffect(() => {
    // Update detectionParams when individual parameter states change
    setDetectionParams({
      loudnessThreshold: threshold.toString() + "dB",
      minSilenceDurationSeconds: minDuration.toString(),
      paddingLeftSeconds: paddingLeft,
      paddingRightSeconds: paddingRight,
    });
  }, [threshold, minDuration, paddingLeft, paddingRight]);

  const [currentActiveFile, setCurrentActiveFile] = useState<ActiveFile | null>(
    {
      path: "/home/oliwoli/my-repos/resocut/frontend/public/audio/preview-render.wav",
      name: "preview-render.wav",
    }
  );

  const { silenceData, isLoading, error, refetch } = useSilenceData(
    currentActiveFile,
    detectionParams
  );

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
            <h1 className="text-sm font-normal text-neutral-200">ResoCut</h1>
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

        <main className="flex-1 gap-8 mt-8">
          <div className="flex flex-col space-y-8">
            {/* Group Threshold, Min Duration, and Padding horizontally */}
            <div className="flex flex-row space-x-6 items-start">
              {" "}
              {/* Added flex container */}
              {/* Threshold Silence Column */}
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
                  <span className="text-sm text-zinc-100 whitespace-nowrap">
                    {threshold.toFixed(2)} dB
                  </span>
                </div>
              </div>
              <div className="flex flex-col space-y-2 w-full">
                {/* Wavesurfer Player */}
                <WaveformPlayer
                  audioUrl="/audio/preview-render.wav"
                  silenceData={silenceData}
                />

                {/* Minimum Duration Column */}
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
                        className="w-full" // Changed from w-64 to w-full for better responsiveness
                      />
                      <span className="text-sm text-zinc-100">
                        {minDuration.toFixed(2)}s
                      </span>
                      <ResetButton onClick={resetMinDuration} />
                    </div>
                  </div>
                </div>

                {/* Padding Column */}
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
                        {" "}
                        {/* Changed from w-64 */}
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
                  {/* test audio native html
                  <audio
                    src="http://localhost:34115/preview-render.ogg"
                    controls
                    className="w-full"
                  /> */}

                  {/* <SilenceDataLog
                    activeFile={currentActiveFile}
                    silenceData={silenceData}
                    isLoading={isLoading}
                    error={error}
                  /> */}
                  <div className="items-center space-y-2">
                    {/* Make New Timeline */}
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        checked={makeNewTimeline}
                        onCheckedChange={(checked) =>
                          setMakeNewTimeline(checked === true)
                        }
                      />
                      <Label className="text-base">Make new timeline</Label>
                    </div>
                    <PythonRunnerComponent
                      threshold={threshold}
                      minDuration={minDuration}
                      padLeft={paddingLeft}
                      padRight={paddingRight}
                      makeNewTimeline={makeNewTimeline}
                    />
                  </div>
                </div>
              </div>
            </div>{" "}
            {/* End of flex row container */}
          </div>
        </main>
      </div>
    </>
  );
}
