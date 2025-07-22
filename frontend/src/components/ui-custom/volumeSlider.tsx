import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useGlobalStore } from "@/stores/clipStore";
import * as React from "react";
import * as slider from "@zag-js/slider";
import { useMachine, normalizeProps } from "@zag-js/react";

const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface SliderProps {
  marks?: number[];
  defaultDb?: number;
  minDb?: number;
  maxDb?: number;
  onGainChange: (value: number) => void;
  onDoubleClick?: () => void;
}

export function ThresholdSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  onGainChange,
  onDoubleClick = () => {},
}: SliderProps) {
  const [currentDbValue, setCurrentDbValue] = useState(defaultDb);

  useEffect(() => {
    setCurrentDbValue(defaultDb);
  }, [defaultDb]);

  const handleChange = (values: number[]) => {
    const newDb = values[0];
    setCurrentDbValue(newDb);
    onGainChange(newDb);
  };

  const actualMinDb = Math.min(minDb, maxDb);
  const actualMaxDb = Math.max(minDb, maxDb);
  const rangeDb = actualMaxDb - actualMinDb;

  const setIsThresholdDragging = useGlobalStore((s) => s.setIsThresholdDragging);

  const service = useMachine(slider.machine, {
    id: React.useId(),
    value: [currentDbValue],
    defaultValue: [defaultDb],
    thumbAlignment: "center",
    min: actualMinDb,
    max: actualMaxDb,
    step: rangeDb > 0 ? rangeDb / 500 : 0.1,
    orientation: "vertical",
    onValueChange: (details: { value: number[] }) => {
      handleChange(details.value);
    },
    onValueChangeEnd: () => {
      setIsThresholdDragging(false);
    },
  });
  const api = slider.connect(service, normalizeProps);

  return (
    <div className="flex items-center h-[calc(100%-92px)] select-none pb-[5px] pt-0 px-5">
      <div
        {...api.getRootProps()}
        onDoubleClick={onDoubleClick}
        className="relative flex touch-none select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-6 z-10"
      >
        {/* Slider Control */}
        <div {...api.getControlProps()} className="relative h-full w-full">
          {/* Track */}
          <div
            {...api.getTrackProps()}
            className="absolute top-0 bottom-0 left-1/2 w-1 bg-black rounded-full transform -translate-x-1/2 outline-1 outline-zinc-800"
          >
            {/* Range Fill */}
            <div
              {...api.getRangeProps()}
              className="h-full bg-transparent rounded-full"
            />
          </div>

          {/* Thumb */}
          {api.value.map((_, index) => (
            <div
              key={index}
              {...api.getThumbProps({ index })}
              className={cn(
                "block h-2 w-8 bg-zinc-300 rounded-xs relative shadow-md shadow-zinc-950/80",
                "left-[0px], right-[25%]",
                "border-2 border-t-zinc-100",
                "ring-offset-0 transition-colors",
                "focus-visible:outline-none focus-visible:ring-8 focus-visible:ring-zinc-200/10 focus-visible:ring-offset-0",
                "disabled:pointer-events-none disabled:opacity-50",
                "hover:bg-zinc-200",
                "absolute left-1/2 -translate-x-1/2"
              )}
            >
              <input {...api.getHiddenInputProps({ index })} />
              <div className="absolute top-1/2 -translate-y-1/2 h-[1px] w-3 bg-zinc-500 pointer-events-none left-1/2 transform -translate-x-1/2" />
            </div>
          ))}
          {/* Markings */}
          <div
            {...api.getMarkerGroupProps()}
            className="absolute inset-0 pointer-events-none left-[-8px]"
          >
            {marks.map((value, i) => (
              <span
                key={i}
                {...api.getMarkerProps({ value })}
                className={`absolute w-2 h-[1px] ${
                  value === (actualMinDb + actualMaxDb) / 2
                    ? "bg-zinc-300"
                    : "bg-zinc-600"
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="relative h-full bottom-0 bg-zinc-950/80 border-1 border-black drop-shadow-zinc-700 drop-shadow-xs w-1 z-0 right-[18px] rounded-xs"></div>

      <div className="relative h-[97.8%] ml-0 top-0 mt-[3.2525%] right-3 font-mono px-1">
        {Array.from({ length: actualMaxDb - actualMinDb + 1 }, (_, i) => {
          const dB = actualMinDb + i;
          const pct =
            rangeDb > 0
              ? ((dB - actualMinDb) / rangeDb) * 100
              : dB === actualMinDb
              ? 0
              : 100;

          const absVal = Math.abs(dB);
          const isLabeled = marks.includes(dB);

          // Refined logic for tick types
          const isMajor = absVal % 10 === 0;
          const isMedium = absVal % 5 === 0 && !isMajor;
          const isSmall = !isMajor && !isMedium;

          const tickWidth = isMajor
            ? "w-[12px]"
            : isMedium || isLabeled
            ? "w-[8px]"
            : "w-[4px]";
          const tickOpacity = isLabeled ? "opacity-80" : "opacity-80";

          return (
            <div
              key={`tick-${dB}`}
              className={cn(
                "absolute left-0 -translate-y-1/2",
                {
                  "[@media(max-height:750px)]:hidden [@container(max-height:100px)]:hidden":
                    isSmall,
                }
              )}
              style={{ bottom: `${pct}%` }}
            >
              <div
                className={`h-[1px] bg-zinc-400 ${tickWidth} ${tickOpacity}`}
              />

              {isLabeled && (
                <div
                  className={cn(
                    "absolute left-[15px] top-1/2 -translate-y-1/2 text-xs text-zinc-400 select-none",
                    {
                      "[@media(max-height:920px)]:hidden [@container(max-height:508px)]:hidden":
                        dB === -5,
                    },
                    {
                      "[@media(max-height:750px)]:hidden [@container(max-height:100px)]:hidden":
                        !isMajor,
                    }
                  )}
                >
                  <span
                    className={cn(
                      isMajor ? "font-bold" : "font-light",
                      "[@media(max-height:750px)]:text-[11px]"
                    )}
                  >
                    {absVal}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}