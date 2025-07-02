import { useEffect, useRef, useState } from "react";
import { useDebounce } from "use-debounce";

export function usePrevious<T>(value: T): T | undefined {
  // Create a ref to store the value. The ref can hold a value of type T,
  // or be undefined on the first render.
  const ref = useRef<T>(undefined);

  // The useEffect hook runs *after* the render cycle.
  // This means ref.current will hold the value from the previous render
  // when the component body executes.
  useEffect(() => {
    // Update the ref's current value to the new value for the *next* render.
    ref.current = value;
  }, [value]); // This effect should re-run whenever the value changes.

  // Return the value from the previous render.
  return ref.current;
}



export const useWindowFocus = (
    onFocus: () => void,
    onBlur: () => void,
    options?: {
        fireOnMount?: boolean;
        throttleMs?: number;
    }
) => {
    const lastCalledRef = useRef(0);
    const throttleMs = options?.throttleMs ?? 0;

    useEffect(() => {
        const callThrottled = (fn: () => void) => {
            const now = Date.now();
            if (now - lastCalledRef.current >= throttleMs) {
                fn();
                lastCalledRef.current = now;
            }
        };

        const handleFocus = () => callThrottled(onFocus);
        const handleBlur = () => callThrottled(onBlur);

        window.addEventListener("focus", handleFocus);
        window.addEventListener("blur", handleBlur);

        if (options?.fireOnMount) {
            callThrottled(onFocus);
        }

        return () => {
            window.removeEventListener("focus", handleFocus);
            window.removeEventListener("blur", handleBlur);
        };
    }, [onFocus, onBlur, options?.fireOnMount, throttleMs]);
};

export interface Dimensions {
  width: number;
  height: number;
}

export const useResizeObserver = <T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  debounceMs: number = 300
): Dimensions | null => {
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [debouncedDimensions] = useDebounce(dimensions, debounceMs);

  useEffect(() => {
    const observeTarget = ref.current;
    if (!observeTarget) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) {
        return;
      }
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });

    resizeObserver.observe(observeTarget);

    return () => {
      resizeObserver.unobserve(observeTarget);
    };
  }, [ref]);

  return debouncedDimensions;
};
