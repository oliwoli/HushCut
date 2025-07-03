import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <div className="relative px-0 py-2 h-full">
      {/* Left inner border */}

      {/* Right inner border */}
      <SliderPrimitive.Root
        data-slot="slider"
        defaultValue={defaultValue}
        value={value}
        min={min}
        max={max}
        className={cn(
          "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col px-1",
          className
        )}
        {...props}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "bg-black relative rounded-full data-[orientation=horizontal]:h-[6px] data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5 border-1 border-zinc-800"
          )}
        >
          <SliderPrimitive.Range
            data-slot="slider-range"
            className={cn(
              "bg-transparent absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
            )}
          />
        </SliderPrimitive.Track>
        {/* Markings Container */}
        <div className="absolute inset-0 flex justify-center items-center">
          <div className="relative h-full" style={{ width: '87.6%' }}> {/* Adjust width here to fine-tune scale */}
            {Array.from({ length: 11 }, (_, i) => {
              const markValue = min + ((max - min) / 10) * (i);
              const percentage = ((markValue - min) / (max - min)) * 100;

              return (
                <div
                  key={i}
                  className={cn(
                    "absolute h-[8px] w-[1px] z-0", // Markings below thumb
                    markValue === (min + max) / 2 ? "bg-zinc-300" : "bg-zinc-600" // Lighter color for 50% mark
                  )}
                  style={{
                    left: `${percentage}%`,
                    top: "-13px", // Position above the track with a gap
                    transform: "translateX(-50%)", // Only horizontal centering
                  }}
                />
              );
            })}
          </div>
        </div>
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          className="border-zinc-400 transition-[color,box-shadow] border-t-zinc-300 border-b-zinc-400 border-b-2 bg-zinc-200 block size-4 shrink-0 rounded-[3px] border focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 w-3 h-7 z-10 overflow-hidden group" // Ensure thumb is on top
        >
          {/* <div className="absolute top-1/2 left-1/2 -translate-y-1/2 h-[80%] rounded-[1px] w-[8px] bg-zinc-100 shadow-2xl pointer-events-none transform -translate-x-1/2 z-1" /> */}
          <div className="absolute top-[4px] h-[70%] w-[3px] bg-zinc-400 pointer-events-none left-1/2 transform -translate-x-1/2 z-2 rounded-full" />
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Root>
    </div >

  )
}

export { Slider }
