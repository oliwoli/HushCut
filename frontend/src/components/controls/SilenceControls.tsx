// components/SilenceControls.tsx

import { defaultParameters, isConstituentClipOverridden, useClipParameter, useClipStore, useHasGroupOverrides } from '@/stores/clipStore';
import { Info, InfoIcon, Link, PowerIcon, PowerOffIcon, Unlink } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

// Import your reusable UI components
import { Button, buttonVariants } from '@/components/ui/button';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import SliderZag from '@/components/ui/sliderZag';
import ResetButton from './ResetButton';
import { Separator } from '@radix-ui/react-dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { DisplayClip } from '@/lib/clipUtils';
import { main } from '@wails/go/models';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { cn, truncateFilename } from '@/lib/utils';


const _MinDurationControl = React.memo(() => {
    const currentClipId = useClipStore(s => s.currentClipId);
    const [minDuration, setMinDuration] = useClipParameter('minDuration');

    const resetMinDuration = useCallback(() => {
        if (!currentClipId) return;
        useClipStore.getState().resetParameterToDefault(currentClipId, 'minDuration');
    }, [currentClipId]);


    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Tooltip delayDuration={350}>
                <Label className="font-normal text-sm w-52 text-stone-400 flex text-center gap-2">
                    Minimum Duration
                    <TooltipTrigger asChild>
                        <InfoIcon className='text-zinc-600/60 hover:text-teal-600 w-3.5' />
                    </TooltipTrigger>
                </Label>
                <TooltipContent className='max-w-50'>
                    <h1 className='font-semibold tracking-tight'>Minimum Silence Duration</h1>
                    <p>Minimum Duration for a segment to be considered silent.</p>
                </TooltipContent>
            </Tooltip>
            <div className="flex items-center space-x-5 h-10">
                <div className="flex w-64 items-center space-x-2" aria-disabled={isDisabled}>
                    <SliderZag
                        id={`min-duration-${currentClipId}`}
                        min={0} max={2} step={0.001}
                        value={[minDuration]}
                        onChange={(vals) => setMinDuration(vals[0])}
                        onDoubleClick={resetMinDuration}
                        className="w-32 max-w-32 min-w-32"
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
        if (!currentClipId) return;
        useClipStore.getState().resetParameterToDefault(currentClipId, 'paddingLeft');
        setPaddingLocked(true);
    }, [currentClipId, setPaddingLocked]);

    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1 h-20'>
            <Label className="font-normal text-sm w-52 text-stone-400 flex text-center gap-2">
                Padding
            </Label>
            <div className="flex items-baseline space-x-5 h-14">
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
                                    <InfoIcon className='text-zinc-600/60 hover:text-teal-600 w-3.5' />
                                </TooltipTrigger>
                                <TooltipContent className='max-w-50'>
                                    <h1 className='font-semibold tracking-tight'>Padding Left</h1>
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
                                className="w-32 max-w-32 min-w-32"
                                disabled={isDisabled}
                                dir='rtl'
                            />
                            <span className='flex left-4'><ResetButton onClick={resetPadding} disabled={isDisabled} /></span>
                        </div>
                        <div className='flex gap-2 text-center items-center'>
                            <span className="text-sm tracking-normal text-zinc-400 text-center">Right: <span className="text-zinc-100 text-sm font-normal font-mono tracking-tighter">{paddingRight.toFixed(2)}<span className="text-zinc-400 ml-1 lowercase">s</span></span></span>
                            <Tooltip delayDuration={350}>
                                <TooltipTrigger asChild>
                                    <InfoIcon className='text-zinc-600/60 hover:text-teal-600 w-3.5' />
                                </TooltipTrigger>
                                <TooltipContent className='max-w-50'>
                                    <h1 className='font-semibold tracking-tight'>Padding Right</h1>
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

    const resetMinContent = useCallback(() => {
        if (!currentClipId) return;
        useClipStore.getState().resetParameterToDefault(currentClipId, 'minContent');
    }, [currentClipId]);

    const isDisabled = !currentClipId;

    return (
        <div className='space-y-1'>
            <Tooltip delayDuration={350}>
                <Label className="font-normal text-sm w-52 text-stone-400 flex text-center gap-2">
                    Silence Merge
                    <TooltipTrigger asChild>
                        <InfoIcon className='text-zinc-600/60 hover:text-teal-600 w-3.5' />
                    </TooltipTrigger>
                </Label>
                <TooltipContent className='max-w-50'>
                    <h1 className='font-semibold tracking-tight'>Silence Merge</h1>
                    <p>Content segments shorter than this will be considered as silence and merged with surrounding silences.</p>
                    <p>Use this to remove mic bumps, lip smacks, etc.</p>
                </TooltipContent>
            </Tooltip>
            <div className="flex items-center space-x-5 h-10">
                <div className="flex w-56 items-center gap-2" aria-disabled={isDisabled}>
                    <SliderZag
                        id={`min-content-${currentClipId}`}
                        min={0} max={1} step={0.01}
                        value={[minContent]}
                        onChange={(vals) => setMinContent(vals[0])}
                        onDoubleClick={resetMinContent}
                        className="w-32 max-w-32 min-w-32"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {minContent.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <span className='flex'><ResetButton onClick={resetMinContent} disabled={isDisabled} /></span>
                </div>
            </div>
        </div>
    );
});


interface SilenceControlsProps {
    displayClips?: DisplayClip[];
    audioItems?: main.TimelineItem[];
}

export const SilenceControls: React.FC<SilenceControlsProps> = ({ displayClips, audioItems }) => {
    const currentClipId = useClipStore((s) => s.currentClipId);
    const parameters = useClipStore((s) => s.parameters);

    const activeDisplayClip = useMemo(() => {
        if (!displayClips || !currentClipId) return null;
        return (
            displayClips.find(
                (clip) =>
                    clip.id === currentClipId ||
                    Boolean(clip.constituent_item_ids?.includes(currentClipId))
            ) || null
        );
    }, [displayClips, currentClipId]);

    const isGroup = Boolean(activeDisplayClip?.is_linked_group);

    const constituentItems = useMemo(() => {
        if (!isGroup || !audioItems || activeDisplayClip?.link_group_id == null) {
            return [];
        }
        return audioItems
            .filter((it) => it.link_group_id === activeDisplayClip.link_group_id)
            .sort((a, b) => a.track_index - b.track_index);
    }, [isGroup, audioItems, activeDisplayClip]);

    const isLocalView = isGroup && activeDisplayClip != null && currentClipId !== activeDisplayClip.id;
    const hasGroupOverrides = useHasGroupOverrides(activeDisplayClip?.constituent_item_ids);
    const [resetDialogOpen, setResetDialogOpen] = useState(false);

    // Per-clip bypass in Local View
    const [bypassed, setBypassed] = useClipParameter("bypassed");

    const handleGlobalReset = useCallback(() => {
        if (!currentClipId) return;
        if (isGroup && !isLocalView && hasGroupOverrides) {
            setResetDialogOpen(true);
            return;
        }
        useClipStore.getState().resetAllParametersToDefault(currentClipId);
    }, [currentClipId, isGroup, isLocalView, hasGroupOverrides]);

    const handleConfirmGlobalReset = useCallback(() => {
        if (!currentClipId) return;
        useClipStore.getState().resetAllParametersToDefault(currentClipId);
        setResetDialogOpen(false);
    }, [currentClipId]);

    const selectValue = isLocalView ? (currentClipId || "") : (activeDisplayClip?.id || "combined");

    const handleSelectChange = (newVal: string) => {
        if (!activeDisplayClip) return;
        if (newVal === activeDisplayClip.id || newVal === "combined") {
            useClipStore.getState().setCurrentClipId(activeDisplayClip.id);
        } else {
            useClipStore.getState().setCurrentClipId(newVal);
        }
    };

    const clipFullName = useMemo(() => {
        if (isLocalView) {
            const item = constituentItems.find((it) => it.id === currentClipId);
            return item?.name || (item ? `Clip on A${item.track_index}` : "Clip");
        }
        return activeDisplayClip?.name || "Clip";
    }, [isLocalView, constituentItems, currentClipId, activeDisplayClip]);

    return (
        <div className="w-full px-2 sm:px-3 xl:px-4 pt-4 sm:pt-5 flex flex-col gap-4 space-y-1">
            <div>
                <div className="flex items-center justify-between gap-3 mb-2 min-h-8">
                    {/* Left: Dropdown selector (grouped clips) OR Title (normal clips) */}
                    <div className="flex items-center gap-2 min-w-0">
                        {!activeDisplayClip ? (
                            <span className="text-sm font-medium text-zinc-400 tracking-tight">
                                Silence Detection
                            </span>
                        ) : isGroup ? (
                            <div className="flex items-center gap-2 min-w-0">
                                <Select value={selectValue} onValueChange={handleSelectChange}>
                                    <SelectTrigger className="h-8 min-w-[200px] max-w-[280px] sm:min-w-[220px] sm:max-w-[340px]">
                                        <SelectValue placeholder="Select view..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={activeDisplayClip.id}>
                                            <span className="font-medium">Combined Overview</span>
                                        </SelectItem>
                                        <SelectSeparator />
                                        {constituentItems.map((item) => {
                                            const itemParams = parameters[item.id];
                                            const isItemBypassed = Boolean(itemParams?.bypassed);
                                            const isItemOverridden = isConstituentClipOverridden(
                                                item.id,
                                                parameters
                                            );
                                            return (
                                                <SelectItem key={item.id} value={item.id}>
                                                    <span className="text-zinc-400 font-mono text-[11px] mr-1.5">
                                                        A{item.track_index}
                                                    </span>
                                                    <span className="truncate">{item.name || `Clip on A${item.track_index}`}</span>
                                                    {isItemBypassed ? (
                                                        <span className="text-orange-400 text-[10px] ml-1.5 font-medium">
                                                            (Bypassed)
                                                        </span>
                                                    ) : isItemOverridden ? (
                                                        <span className="text-teal-400 text-[10px] ml-1.5 font-medium">
                                                            (Custom)
                                                        </span>
                                                    ) : null}
                                                </SelectItem>
                                            );
                                        })}
                                    </SelectContent>
                                </Select>

                                {!isLocalView && (
                                    <Tooltip delayDuration={300}>
                                        <TooltipTrigger asChild>
                                            <InfoIcon className="h-3.5 w-3.5 text-zinc-500 hover:text-teal-400 cursor-pointer shrink-0" />
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs text-xs">
                                            <p className="font-semibold mb-0.5">Combined Overview</p>
                                            <p className="text-zinc-300">
                                                This overview shows you what the edits are going to be like for all clips in the group.
                                            </p>
                                            <p className="text-zinc-300">
                                                Sliders display the average across all clips in this group. Adjusting a parameter offsets all clips relatively, preserving individual adjustments made in Local View.
                                            </p>
                                        </TooltipContent>
                                    </Tooltip>
                                )}
                            </div>
                        ) : (
                            <Tooltip delayDuration={400}>
                                <TooltipTrigger asChild>
                                    <span
                                        className="text-sm font-medium text-zinc-200 tracking-tight truncate max-w-[280px] sm:max-w-[360px] block cursor-default"
                                    >
                                        {truncateFilename(clipFullName, 35)}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-xs font-mono">
                                    {clipFullName}
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>

                    {/* Right: Global Reset + Bypass Button (shown for both grouped and normal clips) */}
                    {activeDisplayClip && (
                        <div className="flex items-center gap-1.5 shrink-0">
                            <ResetButton
                                showPlus
                                onClick={handleGlobalReset}
                                disabled={!currentClipId}
                                title="Reset all parameters to default"
                            />
                            <Button
                                variant="outline"
                                size="sm"
                                type="button"
                                onClick={() => setBypassed(!bypassed)}
                                className={cn(
                                    "h-8 px-2.5 text-xs flex items-center gap-1.5 border transition-colors cursor-pointer shrink-0",
                                    bypassed
                                        ? "border-orange-500/50 bg-orange-950/30 text-orange-400 hover:bg-orange-950/50 hover:text-orange-300"
                                        : "border-zinc-700 bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                                )}
                                title={
                                    bypassed
                                        ? "Enable silence detection for this clip"
                                        : "Disregard (bypass) this clip during silence detection"
                                }
                            >
                                {bypassed ? (
                                    <>
                                        <PowerOffIcon className="h-3.5 w-3.5 text-orange-400" />
                                        <span>Bypassed</span>
                                    </>
                                ) : (
                                    <>
                                        <PowerIcon className="h-3.5 w-3.5 text-zinc-400" />
                                        <span>Bypass Clip</span>
                                    </>
                                )}
                            </Button>
                        </div>
                    )}
                </div>
                <Separator aria-orientation="horizontal" className="h-px bg-zinc-700/80" />
            </div>

            <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
                <AlertDialogContent className="overflow-hidden rounded-sm">
                    <div className="absolute top-0 w-full h-1 bg-teal-800" />
                    <div className="w-5 h-5 px-0 p-0 absolute top-12 left-5">
                        <Info className="fill-teal-950/60 w-7 h-7 text-teal-700 mb-1 text-center" />
                    </div>
                    <AlertDialogHeader className="pl-11 gap-1 mt-2">
                        <AlertDialogTitle className="mb-0 gap-2">
                            Reset All Parameters?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="mt-0">
                            Individual clips in this group have custom settings applied. Resetting in Combined Overview will reset all parameters to their default values and overwrite per-clip adjustments.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="mt-1">
                        <AlertDialogCancel className="cursor-pointer">
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleConfirmGlobalReset}
                            className={cn(
                                buttonVariants({ variant: "default" }),
                                "bg-teal-700 text-white hover:bg-teal-600 focus-visible:border-0 focus-visible:ring-teal-600 focus-visible:ring-2 cursor-pointer"
                            )}
                        >
                            Reset All
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <div>
                <div className="flex flex-wrap gap-6 lg:flex-row lg:items-start lg:gap-6 justify-between transition-all duration-200">
                    {/* Left column */}
                    <div className="flex flex-col gap-4 pb-2">
                        <_MinDurationControl />
                        <_PaddingControl />
                    </div>

                    {/* Right column */}
                    <div className="flex flex-col gap-6">
                        <_MinContentControl />
                    </div>
                </div>
            </div>
        </div>
    );
};
