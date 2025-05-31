import { useEffect } from "react";

export const useWindowFocus = (onFocus: () => void, onBlur: () => void) => {
    useEffect(() => {
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);

        // Call onFocus initially if desired
        //onFocus();

        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("blur", onBlur);
        };
    }, [onFocus, onBlur]);
};
