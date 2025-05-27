import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils"; // Assuming this utility exists

const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface LogSliderProps {
  /** dB marks to display alongside track */
  marks?: number[];
  /** dB value to start slider at, and to reflect external changes */
  defaultDb?: number;
  /** min dB range */
  minDb?: number;
  /** max dB range */
  maxDb?: number;
  /**
   * Called with the current dB value from the slider.
   * Note: Despite the name 'onGainChange', this callback receives the dB value
   * in this linear version of the slider.
   */
  onGainChange: (value: number) => void;
  onDoubleClick?: () => void;
  // The 'exponent' prop has been removed as it's not used for linear dB scaling.
}

export function LogSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  onGainChange,
  onDoubleClick = () => {},
}: LogSliderProps) {
  // State for the slider's current dB value
  const [currentDbValue, setCurrentDbValue] = React.useState(defaultDb);

  // Effect to synchronize internal dB state with defaultDb prop changes
  React.useEffect(() => {
    setCurrentDbValue(defaultDb);
  }, [defaultDb]);

  const handleChange = (values: number[]) => {
    const newDb = values[0]; // newDb is the dB value directly from the slider
    setCurrentDbValue(newDb);
    onGainChange(newDb); // Pass the dB value to the callback
  };

  // Ensure minDb is less than or equal to maxDb for calculations and slider props
  const actualMinDb = Math.min(minDb, maxDb);
  const actualMaxDb = Math.max(minDb, maxDb);
  const rangeDb = actualMaxDb - actualMinDb;

  // Filter marks to be within the slider's range and sort them
  const sortedVisibleMarks = React.useMemo(
    () =>
      marks
        .filter((mark) => mark >= actualMinDb && mark <= actualMaxDb)
        .sort((a, b) => a - b),
    [marks, actualMinDb, actualMaxDb]
  );

  return (
    <>
      <div className="flex items-center h-70 select-none">
        <SliderPrimitive.Root
          orientation="vertical"
          min={actualMinDb} // Slider operates in dB
          max={actualMaxDb} // Slider operates in dB
          // Set a reasonable step in dB, e.g., 500 steps across the range or 0.1dB
          step={rangeDb > 0 ? rangeDb / 500 : 0.1}
          value={[currentDbValue]} // Controlled by the internal 'currentDbValue' state
          onValueChange={handleChange}
          className="relative flex touch-none select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-6 z-10"
        >
          <SliderPrimitive.Track className="bg-none relative grow rounded-none w-1.5">
            <SliderPrimitive.Range className="bg-none absolute w-full rounded-none" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            className={cn(
              "block h-8 w-4 bg-zinc-300 rounded-xs relative shadow-xs shadow-zinc-950",
              "left-[2px]", // Original styling: thumb offset
              "ring-offset-background transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              "hover:bg-foreground/90"
            )}
            onDoubleClick={onDoubleClick}
          >
            <div className="absolute top-1/2  -translate-y-1/2 h-[2px] w-2 bg-zinc-500 shadow-2xl pointer-events-none left-1/2 transform -translate-x-1/2" />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Root>

        {/* Decorative track line (original styling) */}
        <div className="relative h-64 bottom-0 bg-zinc-950/80 border-1 drop-shadow-zinc-700 drop-shadow-xs w-1 z-0 right-[18px] rounded-xs"></div>

        {/* Marks container (original styling, height relative to parent) */}
        <div className="relative h-[89%] ml-1 top-4">
          {sortedVisibleMarks.map((dB) => {
            // Calculate percentage position from the bottom, linearly based on dB value
            // Handles cases where rangeDb might be 0 (minDb === maxDb)
            const pct =
              rangeDb > 0
                ? ((dB - actualMinDb) / rangeDb) * 100
                : dB === actualMinDb
                ? 0
                : 100; // If no range, place at 0% or 100%

            return (
              <div
                key={dB}
                className="absolute left-0 transform -translate-y-1/2 text-xs text-zinc-400 select-none"
                style={{ bottom: `${pct}%` }} // Position mark linearly
              >
                {dB}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
