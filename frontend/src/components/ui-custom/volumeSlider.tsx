import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils"; // Assuming this utility exists
import { useEffect } from "react";

const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface SliderProps {
  marks?: number[];
  defaultDb?: number;
  minDb?: number;
  maxDb?: number;
  onGainChange: (value: number) => void;
  onDoubleClick?: () => void;
}

export function LogSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  onGainChange,
  onDoubleClick = () => { },
}: SliderProps) {
  const [currentDbValue, setCurrentDbValue] = React.useState(defaultDb);

  React.useEffect(() => {
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

  const sortedVisibleMarks = React.useMemo(
    () =>
      marks
        .filter((mark) => mark >= actualMinDb && mark <= actualMaxDb)
        .sort((a, b) => a - b),
    [marks, actualMinDb, actualMaxDb]
  );

  useEffect(() => {
    const handlePointerUp = () => {
      document.body.classList.remove("cursor-none");
    };

    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

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
        onPointerDown={() => {
          document.body.classList.add("cursor-none");
        }}
      >
        <SliderPrimitive.Track className="bg-none relative grow rounded-none w-1.5">
          <SliderPrimitive.Range className="bg-none absolute w-full rounded-none" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className={cn(
            "block h-8 w-4 bg-zinc-300 rounded-xs relative shadow-xs shadow-zinc-950",
            "left-[2px]",
            "ring-offset-background transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:pointer-events-none disabled:opacity-50",
            "hover:bg-foreground/90"
          )}
          onDoubleClick={onDoubleClick}
        >
          <div className="absolute top-1/2  -translate-y-1/2 h-[1px] w-2 bg-zinc-500 shadow-2xl pointer-events-none left-1/2 transform -translate-x-1/2" />
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Root>

      <div className="relative h-66 bottom-0 bg-zinc-950/80 border-1 drop-shadow-zinc-700 drop-shadow-xs w-1 z-0 right-[18px] rounded-xs"></div>

      <div className="relative h-[87%] ml-1 top-[17px]">
        {sortedVisibleMarks.map((dB) => {
          const pct =
            rangeDb > 0
              ? ((dB - actualMinDb) / rangeDb) * 100
              : dB === actualMinDb
                ? 0
                : 100;

          return (
            <div
              key={dB}
              className="absolute left-0 transform -translate-y-1/2 text-xs text-zinc-400 select-none"
              style={{ bottom: `${pct}%` }}
            >
              {dB}
            </div>
          );
        })}
      </div>
    </div>
  );
}
