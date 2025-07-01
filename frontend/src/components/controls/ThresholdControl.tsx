// ThresholdControl.tsx
import React, { useEffect, useState } from 'react';
import { LogSlider } from "@/components/ui-custom/volumeSlider";
import { useDebounce } from 'use-debounce';
import { useClipStore, useClipParameter, useIsClipModified, defaultParameters, useGlobalStore } from '@/stores/clipStore';

interface ThresholdControlProps {
}


const _ThresholdControl: React.FC<ThresholdControlProps> = () => {
    const clipId = useClipStore(s => s.currentClipId);
    if (!clipId) return null
    const [threshold, setThreshold] = useClipParameter("threshold");

    const isModified = useIsClipModified();

    return (
        <div className="h-full">
            <LogSlider
                defaultDb={threshold}
                onGainChange={setThreshold}
                onDoubleClick={() => {
                    console.log("default threshold:", defaultParameters.threshold)
                    setThreshold(defaultParameters.threshold);
                }}

            />
            <div className="h-[40px] flex flex-col items-center text-center mt-0 text-base/tight text-zinc-400 hover:text-zinc-300 p-3">
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
                    {threshold.toFixed(2)} <span className="opacity-80">dB</span>
                </span>
            </div>
        </div>
    );
};

export const ThresholdControl = React.memo(_ThresholdControl);
