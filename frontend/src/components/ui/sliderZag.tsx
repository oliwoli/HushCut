import * as React from "react"
import * as slider from "@zag-js/slider"
import { useMachine, normalizeProps } from "@zag-js/react"

export default function SliderZag() {
  const service = useMachine(slider.machine, {
    id: "1",
    defaultValue: [50],
    thumbAlignment: "center",
    min: 0,
    max: 5,
    step: 0.1,
  })
  const api = slider.connect(service, normalizeProps)

  return (
    <div {...api.getRootProps()} className="w-72 p-4">
      {/* Label & Output */}
      <div className="flex items-center space-x-2 mb-4">
        <label {...api.getLabelProps()} className="text-sm font-medium">
          Volume
        </label>
        <output {...api.getValueTextProps()} className="text-sm">
          {api.value.at(0)}
        </output>
      </div>

      {/* Slider Control */}
      <div {...api.getControlProps()} className="relative h-6">
        {/* Track */}
        <div
          {...api.getTrackProps()}
          className="absolute left-0 right-0 top-1/2 h-1 bg-gray-300 rounded-full transform -translate-y-1/2"
        >
          {/* Range Fill */}
          <div
            {...api.getRangeProps()}
            className="h-full bg-blue-500 rounded-full"
          />
        </div>

        {/* Thumb */}
        {api.value.map((_, index) => (
          <div
            key={index}
            {...api.getThumbProps({ index })}
            className="absolute top-1/2 w-4 h-4 bg-blue-500 rounded-full transform -translate-y-1/2  cursor-pointer"
          >
            <input {...api.getHiddenInputProps({ index })} />
          </div>
        ))}
        <div {...api.getMarkerGroupProps()}>
          <span {...api.getMarkerProps({ value: 1 })}>|</span>
          <span {...api.getMarkerProps({ value: 2 })}>|</span>
          <span {...api.getMarkerProps({ value: 2.5 })}>|</span>
        </div>

      </div>
    </div>
  )
}
