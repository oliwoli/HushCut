// components/SilenceControls.tsx

import { ClipStore, defaultParameters, useClipParameter, useClipStore } from '@/stores/clipStore';
import { Link, Unlink } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useDebounce } from 'use-debounce';
import { shallow } from 'zustand/shallow';

// Import your reusable UI components
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import ResetButton from './ResetButton';


const _MinDurationControl = React.memo(() => {
    const currentClipId = useClipStore(s => s.currentClipId);
    const [minDuration, setMinDuration] = useClipParameter('minDuration');

    const resetMinDuration = useCallback(() => {
        if (!currentClipId) return;
        setMinDuration(defaultParameters.minDuration);
    }, [currentClipId, setMinDuration]);


    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Label className="font-medium w-32 text-stone-400">
                Minimum Duration
            </Label>
            <div className="flex items-center space-x-5">
                <div className="flex w-64 items-center space-x-2" aria-disabled={isDisabled}>
                    <Slider
                        min={0} max={5} step={0.001}
                        value={[minDuration]}
                        onValueChange={(vals) => setMinDuration(vals[0])}
                        className="w-[128px] max-w-[128px] min-w-[128px]"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {minDuration.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <ResetButton onClick={resetMinDuration} disabled={isDisabled} />
                </div>
            </div>
        </div>
    );
});

const _PaddingControl = React.memo(() => {
    const currentClipId = useClipStore(s => s.currentClipId);

    const { paddingLeft, paddingRight, setParameter, setAllParameters } = useStoreWithEqualityFn(
        useClipStore,
        (s: ClipStore) => {
            const activeClipParams = currentClipId ? s.parameters[currentClipId] : undefined;

            return {
                paddingLeft: activeClipParams?.paddingLeft ?? defaultParameters.paddingLeft,
                paddingRight: activeClipParams?.paddingRight ?? defaultParameters.paddingRight,
                setParameter: s.setParameter,
                setAllParameters: s.setAllParameters,
            };
        },
        shallow
    );

    // `paddingLocked` is local UI state, perfect for `useState`.
    const [paddingLocked, setPaddingLinked] = useState(true);

    const handlePaddingChange = useCallback((side: 'left' | 'right', value: number) => {
        if (!currentClipId) return;
        const clampedValue = Math.max(0, value);
        if (paddingLocked) {
            setAllParameters(currentClipId, { paddingLeft: clampedValue, paddingRight: clampedValue });
        } else {
            setParameter(currentClipId, side === 'left' ? 'paddingLeft' : 'paddingRight', clampedValue);
        }
    }, [currentClipId, paddingLocked, setParameter, setAllParameters]);

    const resetPadding = useCallback(() => {
        if (!currentClipId) return;
        setAllParameters(currentClipId, {
            paddingLeft: defaultParameters.paddingLeft,
            paddingRight: defaultParameters.paddingRight,
        });
        setPaddingLinked(true);
    }, [currentClipId, setAllParameters]);

    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Label className="font-medium w-32 text-right text-stone-400">
                Padding
            </Label>
            <div className="flex items-baseline space-x-5">
                <div className="flex items-start space-x-0" aria-disabled={isDisabled}>
                    {/* Left Padding */}
                    <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center">
                            <Slider
                                min={0} max={1} step={0.01}
                                value={[paddingLeft]}
                                onValueChange={(vals) => handlePaddingChange("left", vals[0])}
                                className="w-32"
                                disabled={isDisabled}
                            />
                            <Button variant="ghost" size="icon" onClick={() => setPaddingLinked((l) => !l)} className="text-zinc-500 hover:text-zinc-300 text-center" disabled={isDisabled}>
                                {paddingLocked ? <Link className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
                            </Button>
                        </div>
                        <span className="text-sm text-zinc-400">Left: <span className="text-zinc-100 font-mono tracking-tighter">{paddingLeft.toFixed(2)}<span className="text-zinc-400 ml-1">s</span></span></span>
                    </div>

                    {/* Right Padding */}
                    <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center space-x-2">
                            <Slider
                                min={0} max={1} step={0.05}
                                value={[paddingRight]}
                                onValueChange={(vals) => handlePaddingChange("right", vals[0])}
                                className="w-32"
                                disabled={isDisabled}
                            />
                            <ResetButton onClick={resetPadding} disabled={isDisabled} />
                        </div>
                        <span className="text-sm text-zinc-400">Right: <span className="text-zinc-100 font-mono tracking-tighter">{paddingRight.toFixed(2)}<span className="text-zinc-400 ml-1">s</span></span></span>
                    </div>
                </div>
            </div>
        </div>
    );
});

const _MinContentControl = React.memo(() => {
    const currentClipId = useClipStore(s => s.currentClipId);
    const [minContent, setMinContent] = useClipParameter('minContent');

    const resetMinDuration = useCallback(() => {
        if (!currentClipId) return;
        setMinContent(defaultParameters.minContent);
    }, [currentClipId, setMinContent]);


    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Label className="font-medium w-52 text-stone-400 pt-4">
                Minimum Content Duration
            </Label>
            <div className="flex items-center space-x-5">
                <div className="flex w-64 items-center space-x-2" aria-disabled={isDisabled}>
                    <Slider
                        min={0} max={5} step={0.001}
                        value={[minContent]}
                        onValueChange={(vals) => setMinContent(vals[0])}
                        className="w-[128px] max-w-[128px] min-w-[128px]"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {minContent.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <ResetButton onClick={resetMinDuration} disabled={isDisabled} />
                </div>
            </div>
        </div>
    );
});


export const SilenceControls = () => {
    return (
        <div className="space-y-6 w-full p-5">
            <_MinDurationControl />
            <_PaddingControl />
            <_MinContentControl />
        </div>
    );
}