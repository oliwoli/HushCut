import { useEffect, useRef } from "react";

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
