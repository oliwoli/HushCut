import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface LogSliderProps {
  /** dB marks to display alongside track */
  marks?: number[];
  /** dB value to start slider at */
  defaultDb?: number;
  /** min/max dB range */
  minDb?: number;
  maxDb?: number;
  /** Controls compression (higher = more stretch at top) */
  exponent?: number;
  /** Called with linear gain [0..1] */
  onGainChange: (gain: number) => void;
}

export function LogSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  exponent = 120,
  onGainChange,
}: LogSliderProps) {
  // map dB <-> "gain" using exponent
  const db2gain = (dB: number) => 10 ** (dB / exponent);
  const gain2db = (g: number) => exponent * Math.log10(g);

  const minGain = db2gain(minDb);
  const maxGain = db2gain(maxDb);

  const [gain, setGain] = React.useState(db2gain(defaultDb));

  const handleChange = (values: number[]) => {
    const g = values[0];
    setGain(g);
    onGainChange(gain2db(g));
  };

  return (
    <>
      <div className="flex items-center h-64 select-none">
        <SliderPrimitive.Root
          orientation="vertical"
          min={minGain}
          max={maxGain}
          step={(maxGain - minGain) / 500}
          value={[gain]}
          onValueChange={handleChange}
          className="relative flex touch-none select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-6 z-10" // Adjusted Root width to accommodate wider thumb
        >
          <SliderPrimitive.Track className="bg-none relative grow rounded-none w-1.5">
            <SliderPrimitive.Range className="bg-none absolute w-full rounded-none" />{" "}
            {/* Added rounded-2xl to match track */}
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            className={cn(
              "block h-8 w-4 bg-zinc-300 rounded-xs relative shadow-xs shadow-zinc-950", // h-6 for desired height, w-8 to extend
              "left[2px]",
              "ring-offset-background transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              "hover:bg-foreground/90" // Optional: slight hover effect on the background
            )}
          >
            {/* Thin black line acting as the indicator */}
            <div className="absolute top-1/2 -translate-y-1/2 h-[2px] w-2 bg-zinc-500 shadow-2xl pointer-events-none left-1/2 transform -translate-x-1/2" />
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Root>

        <div className="relative h-58 bg-zinc-950/80 border-1 drop-shadow-zinc-700 drop-shadow-xs w-1 z-0 right-[18px] rounded-xs"></div>
        <div className="relative h-[88%] ml-2 top-4">
          {marks.map((dB) => {
            const g = db2gain(dB);
            const pct = ((g - minGain) / (maxGain - minGain)) * 100;
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
          {/* <div
                    className="absolute -right-6 text-sm font-medium"
                    style={{
                        bottom: `${((gain - minGain) / (maxGain - minGain)) * 100}%`,
                        transform: "translateY(50%)",
                    }}
                >
                    {gain2db(gain).toFixed(1)}
                </div> */}
        </div>
      </div>
    </>
  );
}
