import * as React from "react"
import * as slider from "@zag-js/slider"
import { useMachine, normalizeProps } from "@zag-js/react"

interface SliderZagProps {
  className?: string | undefined,
  value?: number[]
  defaultValue?: number[]
  min?: number
  max?: number
  step?: number
  thumbAlignment?: "center" | "contain" | undefined
  orientation?: "horizontal" | "vertical" | undefined
  dir?: "ltr" | "rtl" | undefined
  onChange?: (value: number[]) => void
  onChangeEnd?: (value: number[]) => void
  disabled?: boolean
  showMarkers?: boolean
  markings?: number[]
  onDoubleClick?: (e: React.MouseEvent<HTMLDivElement>) => void
}

export default function SliderZag({
  value,
  defaultValue = [50],
  min = 0,
  max = 100,
  step = 1,
  thumbAlignment = "center",
  onChange,
  onChangeEnd,
  onDoubleClick,
  disabled = false,
  orientation = "horizontal",
  dir,
  showMarkers = true,
  markings,
  ...rest
}: SliderZagProps) {
  const service = useMachine(slider.machine, {
    id: React.useId(),
    value,
    defaultValue: defaultValue,
    thumbAlignment: thumbAlignment,
    min: min,
    max: max,
    step: step,
    orientation: orientation,
    dir: dir,
    disabled,
    // 👇 Console log on value change
    onValueChange: (details: { value: number[] }) => {
      console.log('SliderZag value changed:', details.value)
      onChange?.(details.value)
    },

    onValueChangeEnd: (details: { value: number[] }) => {
      onChangeEnd?.(details.value)
    },
  });
  const api = slider.connect(service, normalizeProps)

  const resolvedMarkings =
    markings ??
    Array.from({ length: 11 }, (_, i) => min + ((max - min) / 10) * i)

  return (
    <div {...api.getRootProps()} {...rest} onDoubleClick={onDoubleClick} className={`${rest.className ?? ""}`}>
      {/* Label & Output */}
      {/* <div className="flex items-center space-x-2 mb-4">
        <label {...api.getLabelProps()} className="text-sm font-medium">
          Volume
        </label>
        <output {...api.getValueTextProps()} className="text-sm">
          {api.value.at(0)}
        </output>
      </div> */}

      {/* Slider Control */}
      <div {...api.getControlProps()} className="relative h-6">
        {/* Track */}
        <div
          {...api.getTrackProps()}
          className="absolute left-0 right-0 top-1/2 h-1 bg-black rounded-full transform -translate-y-1/2 outline-1 outline-zinc-800"
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
            className="absolute top-1/2 -translate-y-1/2 size-[16px] bg-zinc-200 rounded-full cursor-pointer z-10 border-1 border-zinc-600"
          >
            <input {...api.getHiddenInputProps({ index })} />
          </div>
        ))}
        {showMarkers && (
          <div {...api.getMarkerGroupProps()} className="absolute inset-0 pointer-events-none top-[-8px]">
            {(markings ?? Array.from({ length: 11 }, (_, i) => min + ((max - min) / 10) * i)).map(
              (value, i) => (
                <span
                  key={i}
                  {...api.getMarkerProps({ value })}
                  className={`absolute h-2 w-[1px] ${value === (min + max) / 2 ? "bg-zinc-300" : "bg-zinc-600"
                    }`}
                />
              )
            )}
          </div>
        )}

      </div>
    </div>
  )
}
