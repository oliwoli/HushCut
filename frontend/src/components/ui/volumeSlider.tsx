import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

const defaultMarks = [0, -5, -10, -20, -30, -40, -50, -60];

export interface LogSliderProps {
  /** dB marks to display alongside track */
  marks?: number[];
  /** dB value to start slider at, and to reflect external changes */
  defaultDb?: number;
  /** min/max dB range */
  minDb?: number;
  maxDb?: number;
  /** Controls compression (higher = more stretch at top) */
  exponent?: number;
  /** Called with linear gain [0..1] OR dB value (see note below) */
  onGainChange: (value: number) => void;
  onDoubleClick?: () => void;
}

export function LogSlider({
  marks = defaultMarks,
  minDb = -60,
  maxDb = 0,
  defaultDb = -20,
  exponent = 1000,
  onGainChange,
  onDoubleClick = () => { },
}: LogSliderProps) {
  // map dB <-> "gain" using exponent
  // It's good practice to memoize these if exponent can change frequently,
  // or ensure they are stable if defined inside the component.
  const db2gain = React.useCallback((dB: number) => 10 ** (dB / exponent), [exponent]);
  const gain2db = React.useCallback((g: number) => exponent * Math.log10(g), [exponent]);

  const minGain = db2gain(minDb);
  const maxGain = db2gain(maxDb);

  // Initialize gain state. Use function form for useState to compute only once.
  const [gain, setGain] = React.useState(() => db2gain(defaultDb));

  // Effect to synchronize internal gain state with defaultDb prop changes
  React.useEffect(() => {
    setGain(db2gain(defaultDb));
  }, [defaultDb, db2gain]); // db2gain is in dependency array because it depends on exponent

  const handleChange = (values: number[]) => {
    const g = values[0]; // g is linear gain from the slider
    setGain(g);

    // IMPORTANT NOTE on onGainChange:
    // Your original code called onGainChange(gain2db(g)), passing a dB value.
    // However, the prop type is onGainChange: (gain: number) => void, suggesting linear gain.
    // Please ensure this matches your parent component's expectation.
    // If you want to pass linear gain:
    //onGainChange(g);
    // If you want to pass dB value (as in your original code):
    onGainChange(gain2db(g));
    // For this example, I'll assume you want to pass linear gain as hinted by the prop name.
  };

  return (
    <>
      <div className="flex items-center h-64 select-none">
        <SliderPrimitive.Root
          orientation="vertical"
          min={minGain}
          max={maxGain}
          step={(maxGain - minGain) / 500}
          value={[gain]} // Controlled by the internal 'gain' state
          onValueChange={handleChange}
          className="relative flex touch-none select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-6 z-10"
        >
          <SliderPrimitive.Track className="bg-none relative grow rounded-none w-1.5">
            <SliderPrimitive.Range className="bg-none absolute w-full rounded-none" />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            className={cn(
              "block h-8 w-4 bg-zinc-300 rounded-xs relative shadow-xs shadow-zinc-950",
              "left[2px]",
              "ring-offset-background transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-50",
              "hover:bg-foreground/90"
            )}
            onDoubleClick={onDoubleClick}
          >
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
        </div>
      </div>
    </>
  );
}