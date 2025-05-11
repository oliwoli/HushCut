import React, { useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LogSlider } from "./components/ui/volumeSlider";
import VolumeMeter from "./components/ui/volumeMeter";
import { cn } from "@/lib/utils";

import {
  Settings,
  Lock,
  Unlock,
  Scissors,
  RotateCcw,
  Link,
  Unlink,
} from "lucide-react";
import { RunPythonScriptWithArgs } from "../wailsjs/go/main/App";

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
  const DEFAULT_THRESHOLD = -60;
  const DEFAULT_MIN_DURATION = 0.5;
  const DEFAULT_PADDING = 0.0;

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [minDuration, setMinDuration] = useState(DEFAULT_MIN_DURATION);
  const [paddingLeft, setPaddingLeft] = useState(DEFAULT_PADDING);
  const [paddingRight, setPaddingRight] = useState(DEFAULT_PADDING);
  const [makeNewTimeline, setMakeNewTimeline] = useState(false);
  const [paddingLocked, setPaddingLinked] = useState(true);

  const handleRemoveSilences = () => {
    const args = [
      `--threshold=${threshold}`,
      `--min-duration=${minDuration}`,
      `--pad-left=${paddingLeft}`,
      `--pad-right=${paddingRight}`,
      makeNewTimeline ? "--new-timeline" : "",
    ].filter(Boolean);

    RunPythonScriptWithArgs(args);
  };

  function RemoveSilenceBtnComponent() {
    const [pressed, setPressed] = useState(false);

    const handleMouseDown = () => {
      setPressed(true);
    };

    const handleClick = () => {
      handleRemoveSilences();

      // Reset animation shortly after click
      setTimeout(() => setPressed(false), 50); // Adjust to match your transition
    };

    return (
      <Button
        size="lg"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        className={`bg-emerald-600 hover:bg-emerald-700 hover:scale-[101%] text-white py-6 px-12 font-bold border-b-4 border-r-2 border-emerald-900 transition-all ${
          pressed ? "border-0 scale-[99%] translate-y-0.5" : ""
        }`}
      >
        <Scissors className="h-6 w-6 ml-2" />
        Remove Silence
      </Button>
    );
  }

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

  return (
    <div className="h-screen p-6 bg-[#28282e]">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-neutral-400">ResoCut</h1>
        <Button
          size="icon"
          className="hover:bg-zinc-600/20 bg-transparent hover:text-white"
        >
          <Settings className="h-6 w-6 text-zinc-400 opacity-80 hover:text-blue-500 hover:opacity-100" />
        </Button>
      </header>

      <main className="flex-1 gap-8 mt-8">
        <VolumeMeter />
        <div className="flex flex-col space-y-8">
          {/* Volume Slider */}
          <div className="flex items-center space-x-4">
            <LogSlider
              defaultDb={-20}
              onGainChange={(gain) => console.log("Gain changed:", gain)}
            />
          </div>
          {/* Threshold Loudness */}
          <div className="space-y-2">
            <Label className="font-medium">Threshold Loudness</Label>
            <p className="text-sm text-zinc-500">
              Set the threshold for silence detection.
            </p>
            <div className="flex items-center space-x-2">
              <Slider
                min={-80}
                max={0}
                step={1}
                value={[threshold]}
                onValueChange={(vals) => setThreshold(vals[0])}
                className="w-64"
              />
              <span className="text-sm text-zinc-100 text-nowrap">
                {threshold} dB
              </span>
              <ResetButton onClick={resetThreshold} />
            </div>
          </div>

          {/* Minimum Duration */}
          <div className="space-y-2">
            <Label className="font-medium">Minimum Duration</Label>
            <p className="text-sm text-zinc-500">
              Silence longer than this will be cut.
            </p>
            <div className="flex items-center space-x-2">
              <Slider
                min={0}
                max={5}
                step={0.001}
                value={[minDuration]}
                onValueChange={(vals) => setMinDuration(vals[0])}
                className="w-64"
              />
              <span className="text-sm text-zinc-100">
                {minDuration.toFixed(3)}s
              </span>
              <ResetButton onClick={resetMinDuration} />
            </div>
          </div>

          {/* Padding */}
          <div className="space-y-2">
            <Label className="font-medium">Padding</Label>
            <p className="text-sm text-zinc-500">
              Extend clips before cutting.
            </p>
            <div className="flex items-start space-x-6">
              {/* Left Padding */}
              <div className="flex flex-col space-y-1 w-64">
                <div className="flex items-center space-x-2">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[paddingLeft]}
                    onValueChange={(vals) =>
                      handlePaddingChange("left", vals[0])
                    }
                    className="w-full"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setPaddingLinked((l) => !l)}
                    className="text-zinc-500 hover:text-zinc-300"
                  >
                    {paddingLocked ? (
                      <Link className="h-2 w-2 ml-4" />
                    ) : (
                      <Unlink className="h-2 w-2 ml-4" />
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
              <div className="flex flex-col space-y-1 w-64">
                <div className="flex items-center space-x-2">
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[paddingRight]}
                    onValueChange={(vals) =>
                      handlePaddingChange("right", vals[0])
                    }
                    className="w-full"
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
        </div>
      </main>

      <footer className="mt-8 flex justify-left">
        <RemoveSilenceBtnComponent />
      </footer>
    </div>
  );
}
