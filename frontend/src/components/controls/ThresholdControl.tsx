import React, { useEffect, useState } from 'react';
import { LogSlider } from "@/components/ui-custom/volumeSlider";
import { useDebounce } from 'use-debounce';

interface ThresholdControlProps {
    threshold: number;
    setThreshold: (value: number) => void;
    resetThreshold: () => void;
}

const _ThresholdControl: React.FC<ThresholdControlProps> = ({ threshold, setThreshold, resetThreshold }) => {
    const [immediateValue, setImmediateValue] = useState(threshold);
    const [debouncedValue] = useDebounce(immediateValue, 60); // 300ms debounce

    useEffect(() => {
        setThreshold(debouncedValue);
    }, [debouncedValue, setThreshold]);

    // Sync UI if external `minDuration` changes (e.g., reset button)
    useEffect(() => {
        setImmediateValue(threshold);
    }, [threshold]);


    return (
        <div className="flex flex-col space-y-1 items-center">
            <LogSlider
                defaultDb={threshold}
                onGainChange={setImmediateValue}
                onDoubleClick={resetThreshold}
            />
            <div className="flex flex-col items-center text-center mt-0 text-base/tight text-zinc-400 hover:text-zinc-300">
                <p className="text-base/tight">
                    Silence
                    <br />
                    Threshold
                </p>
                <span className="text-xs text-zinc-100 whitespace-nowrap font-mono tracking-tighter mt-1">
                    {threshold.toFixed(2)}{" "}
                    <span className="opacity-80">dB</span>
                </span>
            </div>
        </div>
    );
};

export const ThresholdControl = React.memo(_ThresholdControl);