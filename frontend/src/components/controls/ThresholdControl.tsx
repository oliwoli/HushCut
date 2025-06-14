// ThresholdControl.tsx
import React, { useEffect, useState } from 'react';
import { LogSlider } from "@/components/ui-custom/volumeSlider";
import { useDebounce } from 'use-debounce';
import { useClipStore, useClipParameter, useIsClipModified, defaultParameters } from '@/stores/clipStore';

interface ThresholdControlProps {
}


const _ThresholdControl: React.FC<ThresholdControlProps> = () => {
    const clipId = useClipStore(s => s.currentClipId);
    if (!clipId) return null
    const [threshold, setThreshold] = useClipParameter("threshold");


    const isModified = useIsClipModified();


    const [immediateValue, setImmediateValue] = useState(threshold);
    const [debouncedValue] = useDebounce(immediateValue, 30); // debounce for smoother updates

    useEffect(() => {
        setThreshold(debouncedValue);
    }, [debouncedValue, setThreshold]);

    useEffect(() => {
        setImmediateValue(threshold);
    }, [threshold]);

    return (
        <div className="flex flex-col space-y-1 items-center">
            <LogSlider
                defaultDb={threshold}
                onGainChange={setImmediateValue}
                onDoubleClick={() => {
                    console.log("default threshold:", defaultParameters.threshold)
                    setImmediateValue(defaultParameters.threshold);
                }}
            />
            <div className="flex flex-col items-center text-center mt-0 text-base/tight text-zinc-400 hover:text-zinc-300">
                <p className="text-base/tight">
                    Silence
                    <br />
                    Threshold
                </p>
                {/* <p className={`text-base/tight ${!isModified ? 'text-yellow-400' : ''}`}>
                    Silence
                    <br />
                    Threshold
                </p> */}
                <span className="text-xs text-zinc-100 whitespace-nowrap font-mono tracking-tighter mt-1">
                    {immediateValue.toFixed(2)} <span className="opacity-80">dB</span>
                </span>
            </div>
        </div>
    );
};

export const ThresholdControl = React.memo(_ThresholdControl);
