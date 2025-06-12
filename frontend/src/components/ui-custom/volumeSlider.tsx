import { cn } from "@/lib/utils"; // Assuming this utility exists
import { memo, useEffect, useMemo, useState } from "react";
import * as SliderPrimitive from "@radix-ui/react-slider"



const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface SliderProps {
  marks?: number[];
  defaultDb?: number;
  minDb?: number;
  maxDb?: number;
  onGainChange: (value: number) => void;
  onDoubleClick?: () => void;
}

export function _LogSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  onGainChange,
  onDoubleClick = () => { },
}: SliderProps) {
  const [currentDbValue, setCurrentDbValue] = useState(defaultDb);

  useEffect(() => {
    setCurrentDbValue(defaultDb);
  }, [defaultDb]);

  const handleChange = (values: number[]) => {
    const newDb = values[0]; // newDb is the dB value directly from the slider
    setCurrentDbValue(newDb);
    onGainChange(newDb); // Pass the dB value to the callback
  };

  const actualMinDb = Math.min(minDb, maxDb);
  const actualMaxDb = Math.max(minDb, maxDb);
  const rangeDb = actualMaxDb - actualMinDb;

  return (
    <div className="flex items-center h-[287px] select-none mt-[5px]">
      <SliderPrimitive.Root
        orientation="vertical"
        min={actualMinDb}
        max={actualMaxDb}
        step={rangeDb > 0 ? rangeDb / 500 : 0.1}
        value={[currentDbValue]}
        onValueChange={handleChange}
        className="relative flex touch-none select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-6 z-10"
      >
        <SliderPrimitive.Track className="bg-none relative grow rounded-none w-1">
          <SliderPrimitive.Range className="bg-none absolute w-full rounded-none" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className={cn(
            "block h-2 w-8 bg-zinc-300 rounded-xs relative shadow-md shadow-zinc-950/80",
            "left-[0px], right-[25%]",
            "border-2 border-t-zinc-100",
            "ring-offset-0 transition-colors",
            "focus-visible:outline-none focus-visible:ring-8 focus-visible:ring-zinc-200/10 focus-visible:ring-offset-0",
            "disabled:pointer-events-none disabled:opacity-50",
            "hover:bg-zinc-200"
          )}
          onDoubleClick={onDoubleClick}
        >
          <div className="absolute top-1/2 -translate-y-1/2 h-[1px] w-2 bg-zinc-500 shadow-2xl pointer-events-none left-1/2 transform -translate-x-1/2" />
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Root>

      <div className="relative h-66 bottom-0 bg-zinc-950/80 border-1 drop-shadow-zinc-700 drop-shadow-xs w-1 z-0 right-[18px] rounded-xs"></div>

      <div className="relative h-[87%] ml-0 top-[2px] right-3 font-mono">
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
          const isMajor = absVal % 10 === 0;
          const isMedium = !isLabeled && absVal % 5 === 0;

          const tickWidth = isMajor
            ? "w-[12px]"
            : isMedium || isLabeled
              ? "w-[8px]"
              : "w-[4px]";

          const tickOpacity = isLabeled ? "opacity-80" : "opacity-80";

          return (
            <div
              key={`tick-${dB}`}
              className="absolute left-0 -translate-y-1/2"
              style={{ bottom: `${pct}%` }}
            >
              <div
                className={`h-[1px] bg-zinc-400 ${tickWidth} ${tickOpacity}`}
              />

              {isLabeled && (
                <div className="absolute left-[15px] top-1/2 -translate-y-1/2 text-xs text-zinc-400 select-none">
                  <span
                    className={absVal % 10 === 0 ? "font-bold" : "font-light"}
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

// Custom props comparison
function areEqual(prev: SliderProps, next: SliderProps) {
  return (
    prev.defaultDb === next.defaultDb &&
    prev.minDb === next.minDb &&
    prev.maxDb === next.maxDb &&
    prev.onGainChange === next.onGainChange &&
    prev.onDoubleClick === next.onDoubleClick &&
    JSON.stringify(prev.marks) === JSON.stringify(next.marks)
  );
}

export const LogSlider = memo(_LogSlider, areEqual);