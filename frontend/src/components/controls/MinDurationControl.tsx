import React, { useEffect, useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import ResetButton from './ResetButton';

interface MinDurationControlProps {
    minDuration: number;
    setMinDuration: (value: number) => void;
    resetMinDuration: () => void;
}

const _MinDurationControl: React.FC<MinDurationControlProps> = ({
    minDuration,
    setMinDuration,
    resetMinDuration
}) => {
    const [immediateValue, setImmediateValue] = useState(minDuration);
    const [debouncedValue] = useDebounce(immediateValue, 300); // 300ms debounce

    useEffect(() => {
        setMinDuration(debouncedValue);
    }, [debouncedValue, setMinDuration]);

    // Sync UI if external `minDuration` changes (e.g., reset button)
    useEffect(() => {
        setImmediateValue(minDuration);
    }, [minDuration]);

    return (
        <div className="space-y-2 w-full p-5">
            <div className="flex items-center space-x-5">
                <Label className="font-medium w-32 flex-row-reverse">
                    Minimum Duration
                </Label>
                <div className="flex w-64 items-center space-x-2">
                    <Slider
                        min={0}
                        max={5}
                        step={0.001}
                        value={[immediateValue]}
                        onValueChange={(vals) => setImmediateValue(vals[0])}
                        className="w-[128px] max-w-[128px] min-w-[128px]"
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {immediateValue.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <ResetButton onClick={resetMinDuration} />
                </div>
            </div>
        </div>
    );
};

export const MinDurationControl = React.memo(_MinDurationControl);
