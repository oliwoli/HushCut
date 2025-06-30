import React, { useCallback, useEffect, useState } from 'react';
import { useDebounce } from 'use-debounce';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import ResetButton from './ResetButton';

import { useClipStore, useClipParameter, defaultParameters } from '@/stores/clipStore';


interface MinDurationControlProps { }
const _MinDurationControl: React.FC<MinDurationControlProps> = () => {
    const currentClipId = useClipStore(s => s.currentClipId);

    const [minDuration, setMinDuration] = useClipParameter(
        'minDuration'
    );

    const setParameter = useClipStore(s => s.setParameter);
    const resetMinDuration = useCallback(() => {
        if (!currentClipId) return;
        setParameter(currentClipId, 'minDuration', defaultParameters.minDuration);
    }, [currentClipId, setParameter]);

    const [immediateValue, setImmediateValue] = useState(minDuration);
    const [debouncedValue] = useDebounce(immediateValue, 300);

    useEffect(() => {
        if (!currentClipId) return;
        setMinDuration(debouncedValue);
    }, [debouncedValue, setMinDuration, currentClipId]);

    useEffect(() => {
        setImmediateValue(minDuration);
    }, [minDuration]);

    const isDisabled = !currentClipId;

    return (
        <div className="space-y-2 w-full p-5">
            <div className="flex items-center space-x-5">
                <Label className="font-medium w-32 flex-row-reverse">
                    Minimum Duration
                </Label>
                <div className="flex w-64 items-center space-x-2" aria-disabled={isDisabled}>
                    <Slider
                        min={0}
                        max={5}
                        step={0.001}
                        value={[immediateValue]}
                        onValueChange={(vals) => setImmediateValue(vals[0])}
                        onDoubleClick={resetMinDuration}
                        className="w-[128px] max-w-[128px] min-w-[128px]"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {immediateValue.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <ResetButton onClick={resetMinDuration} disabled={isDisabled} />
                </div>
            </div>
        </div>
    );
};

export const MinDurationControl = React.memo(_MinDurationControl);