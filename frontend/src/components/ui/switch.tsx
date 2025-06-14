import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Track styles
        "peer inline-flex h-[1rem] w-[1.9rem] shrink-0 items-center rounded-full bg-[#111] transition-colors duration-100",
        "data-[state=checked]:bg-[#111] data-[state=unchecked]:bg-[#111]",
        "focus-visible:outline-none focus-visible:ring-0",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // Thumb styles
          "pointer-events-none block size-[0.6rem] rounded-full transition-transform duration-200",
          "transform data-[state=checked]:translate-x-[calc(100%+6px)] data-[state=unchecked]:translate-x-1",
          "data-[state=checked]:bg-[#d30000]", // bright red when on
          "data-[state=unchecked]:bg-[#444]" // dark gray when off
        )}
      />
    </SwitchPrimitive.Root>
  );
}


export { Switch }
