// components/SilenceControls.tsx

import { defaultParameters, useClipParameter, useClipStore } from '@/stores/clipStore';
import { ChevronDown, ChevronDownIcon, ChevronUpIcon, InfoIcon, Link, Unlink } from 'lucide-react';
import React, { useCallback, useState } from 'react';

// Import your reusable UI components
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import SliderZag from '@/components/ui/sliderZag';
import ResetButton from './ResetButton';
import { Separator } from '@radix-ui/react-dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';


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
            <Tooltip delayDuration={350}>
                <Label className="font-normal text-sm w-52 text-stone-400  flex text-center gap-2">
                    Minimum Duration
                    <TooltipTrigger asChild>
                        <InfoIcon size={16} className='text-zinc-600/60 hover:text-teal-600' />
                    </TooltipTrigger>
                </Label>
                <TooltipContent className='max-w-[200px]'>
                    <h1 className='font-[600] tracking-tight'>Minimum Silence Duration</h1>
                    <p>Minimum Duration for a segment to be considered silent.</p>
                </TooltipContent>
            </Tooltip>
            <div className="flex items-center space-x-5">
                <div className="flex w-64 items-center space-x-2" aria-disabled={isDisabled}>
                    <SliderZag
                        id={`min-duration-${currentClipId}`}
                        min={0} max={2} step={0.001}
                        value={[minDuration]}
                        onChange={(vals) => setMinDuration(vals[0])}
                        onDoubleClick={resetMinDuration}
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
    const [paddingLeft, setPaddingLeft] = useClipParameter('paddingLeft');
    const [paddingRight, setPaddingRight] = useClipParameter('paddingRight');
    const [paddingLocked, setPaddingLocked] = useClipParameter('paddingLocked');

    const handlePaddingChange = useCallback((side: 'left' | 'right', value: number) => {
        const clampedValue = Math.max(0, value);
        if (paddingLocked) {
            setPaddingLeft(clampedValue);
            setPaddingRight(clampedValue);
        } else {
            if (side === 'left') {
                setPaddingLeft(clampedValue);
            } else {
                setPaddingRight(clampedValue);
            }
        }
    }, [paddingLocked, setPaddingLeft, setPaddingRight]);

    const resetPadding = useCallback(() => {
        setPaddingLeft(defaultParameters.paddingLeft);
        setPaddingRight(defaultParameters.paddingRight);
        setPaddingLocked(true);
    }, [setPaddingLeft, setPaddingRight, setPaddingLocked]);

    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Label className="font-normal text-sm w-52 text-stone-400 flex text-center gap-2">
                Padding
            </Label>
            <div className="flex items-baseline space-x-5">
                <div className="flex items-start space-x-0" aria-disabled={isDisabled}>
                    {/* Left Padding */}
                    <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center">
                            <SliderZag
                                id={`padding-l-${currentClipId}`}
                                min={0} max={1} step={0.01}
                                value={[paddingLeft]}
                                onChange={(vals) => handlePaddingChange("left", vals[0])}
                                onDoubleClick={() => handlePaddingChange("left", defaultParameters.paddingLeft)}
                                className="w-32"
                                disabled={isDisabled}
                            />
                            <Button variant="ghost" size="icon" onClick={() => setPaddingLocked(!paddingLocked)} className="text-zinc-500 pl-2 hover:text-zinc-300 text-center" disabled={isDisabled}>
                                {paddingLocked ? <Link className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
                            </Button>
                        </div>
                        <div className='items-center flex gap-2 text-center'>
                            <span className="text-sm tracking-normal text-zinc-400 text-center">Left: <span className="text-zinc-100 text-sm font-normal font-mono tracking-tighter">{paddingLeft.toFixed(2)}<span className="text-zinc-400 ml-1 lowercase">s</span></span></span>
                            <Tooltip delayDuration={350}>
                                <TooltipTrigger asChild>
                                    <InfoIcon size={16} className='text-zinc-600/60 hover:text-teal-600' />
                                </TooltipTrigger>
                                <TooltipContent className='max-w-[200px]'>
                                    <h1 className='font-[600] tracking-tight'>Padding Left</h1>
                                    <p>Trims the start of the silence.</p>
                                    <p>Content before the detected silence extends.</p>
                                </TooltipContent>
                            </Tooltip>
                        </div>
                    </div>

                    {/* Right Padding */}
                    <div className="flex flex-col space-y-1 w-full">
                        <div className="flex items-center space-x-2">
                            <SliderZag
                                id={`padding-r-${currentClipId}`}
                                min={0} max={1} step={0.01}
                                value={[paddingRight]}
                                onChange={(vals) => handlePaddingChange("right", vals[0])}
                                onDoubleClick={() => handlePaddingChange("right", defaultParameters.paddingRight)}
                                className="w-[128px] max-w-[128px] min-w-[128px]"
                                disabled={isDisabled}
                                dir='rtl'
                            />
                            <span className='relative left-4'><ResetButton onClick={resetPadding} disabled={isDisabled} /></span>
                        </div>
                        <div className='flex gap-2 text-center items-center'>
                            <span className="text-sm tracking-normal text-zinc-400 text-center">Right: <span className="text-zinc-100 text-sm font-normal font-mono tracking-tighter">{paddingRight.toFixed(2)}<span className="text-zinc-400 ml-1 lowercase">s</span></span></span>
                            <Tooltip delayDuration={350}>
                                <TooltipTrigger asChild>
                                    <InfoIcon size={16} className='text-zinc-600/60 hover:text-teal-600' />
                                </TooltipTrigger>
                                <TooltipContent className='max-w-[200px]'>
                                    <h1 className='font-[600] tracking-tight'>Padding Right</h1>
                                    <p>Trims the end of the silence.</p>
                                    <p>The content after the detected silence starts sooner.</p>
                                </TooltipContent>
                            </Tooltip>
                        </div>
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
            <Tooltip delayDuration={350}>
                <Label className="font-normal text-sm w-52 text-stone-400 flex text-center gap-2">
                    Silence Merge
                    <TooltipTrigger asChild>
                        <InfoIcon size={16} className='text-zinc-600/60 hover:text-teal-600' />
                    </TooltipTrigger>
                </Label>
                <TooltipContent className='max-w-[200px]'>
                    <h1 className='font-[600] tracking-tight'>Silence Merge</h1>
                    <p>Content segments shorter than this will be considered as silence and merged with surrounding silences.</p>
                    <p>Use this to remove mic bumps, lip smacks, etc.</p>

                </TooltipContent>
            </Tooltip>
            <div className="flex items-center space-x-5">
                <div className="flex w-56 items-center gap-2" aria-disabled={isDisabled}>
                    <SliderZag
                        id={`min-content-${currentClipId}`}
                        min={0} max={1} step={0.01}
                        value={[minContent]}
                        onChange={(vals) => setMinContent(vals[0])}
                        onDoubleClick={resetMinDuration}
                        className="w-[128px] max-w-[128px] min-w-[128px]"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {minContent.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <span className='relative'><ResetButton onClick={resetMinDuration} disabled={isDisabled} /></span>
                </div>
            </div>
        </div>
    );
});


export const SilenceControls = () => {
    const [showAll, setShowAll] = useState(true);

    const handleToggleClick = () => {
        setShowAll(!showAll)
    }

    return (
        <div className="w-full px-2 sm:px-3 xl:px-4 pt-4 sm:pt-5 flex flex-col gap-6 space-y-1">
            <div>
                <div className='flex gap-2 items-center mb-2' onClick={handleToggleClick}>
                    <Label className="block text-sm/tight leading-3 text-zinc-200 font-normal tracking-[-0.0125rem]">Silence Detection</Label>
                    {showAll && (
                        <ChevronUpIcon size={16} className='text-gray-500' />
                    )}
                </div>
                <Separator aria-orientation="horizontal" className="h-px bg-zinc-700/80" />
            </div>
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-5 justify-between">
                {/* Left column */}
                <div className="flex flex-col gap-6">
                    <_MinDurationControl />
                    {showAll && (
                        <_PaddingControl />
                    )}
                </div>

                {/* Right column */}
                {showAll && (
                    <div className="flex flex-col gap-6">
                        <_MinContentControl />
                    </div>
                )}

                {!showAll && (
                    <div onClick={handleToggleClick} className='text-sm ml-[-8px] flex gap-2 items-center mt-[-12px] mb-[-8px] text-gray-400 hover:text-zinc-200 w-32 p-2'>
                        show all
                        <ChevronDownIcon size={16} className='' />
                    </div>
                )}
            </div>

        </div>
    );
};