// components/SilenceControls.tsx

import { defaultParameters, useClipParameter, useClipStore, useHasGroupOverrides } from '@/stores/clipStore';
import { ChevronDown, ChevronDownIcon, ChevronUpIcon, InfoIcon, LayersIcon, Link, PowerIcon, PowerOffIcon, Unlink } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

// Import your reusable UI components
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import SliderZag from '@/components/ui/sliderZag';
import ResetButton from './ResetButton';
import { Separator } from '@radix-ui/react-dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { DisplayClip } from '@/lib/clipUtils';
import { main } from '@wails/go/models';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { Checkbox } from '../ui/checkbox';
import { useUiStore } from '@/stores/uiStore';
import { GetSettings, SaveSettings } from '@wails/go/main/App';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';


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
        setPaddingLeft(defaultParameters.paddingLeft);
        setPaddingRight(defaultParameters.paddingRight);
        setPaddingLocked(true);
    }, [setPaddingLeft, setPaddingRight, setPaddingLocked]);

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
                        onDoubleClick={resetMinDuration}
                        className="w-32 max-w-32 min-w-32"
                        disabled={isDisabled}
                    />
                    <span className="text-sm text-zinc-100 font-mono tracking-tighter">
                        {minContent.toFixed(2)}
                        <span className="text-zinc-400 ml-1">s</span>
                    </span>
                    <span className='flex'><ResetButton onClick={resetMinDuration} disabled={isDisabled} /></span>
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

    const constituentIds = useMemo(
        () => constituentItems.map((it) => it.id),
        [constituentItems]
    );

    const hasOverrides = useHasGroupOverrides(constituentIds);
    const isLocalView = isGroup && activeDisplayClip != null && currentClipId !== activeDisplayClip.id;

    // Per-clip bypass in Local View
    const [bypassed, setBypassed] = useClipParameter("bypassed");

    // Overwrite confirmation dialog states
    const confirmOverwritePerClip = useUiStore((s) => s.confirmOverwritePerClipChanges);
    const setConfirmOverwritePerClip = useUiStore((s) => s.setConfirmOverwritePerClipChanges);
    const [isOverwriteDialogOpen, setIsOverwriteDialogOpen] = useState(false);
    const [dontShowAgain, setDontShowAgain] = useState(false);

    const selectValue = isLocalView ? (currentClipId || "") : (activeDisplayClip?.id || "combined");

    const handleSelectChange = (newVal: string) => {
        if (!activeDisplayClip) return;
        if (newVal === activeDisplayClip.id || newVal === "combined") {
            useClipStore.getState().setCurrentClipId(activeDisplayClip.id);
        } else {
            useClipStore.getState().setCurrentClipId(newVal);
        }
    };

    const handleOverwriteClick = () => {
        if (confirmOverwritePerClip) {
            setIsOverwriteDialogOpen(true);
        } else {
            useClipStore.getState().clearClipOverrides(constituentIds);
            toast.success("Applied group settings to all clips in this group.");
        }
    };

    const handleConfirmOverwrite = () => {
        if (dontShowAgain) {
            setConfirmOverwritePerClip(false);
            GetSettings().then((s: any) => {
                SaveSettings({ ...s, confirmOverwritePerClipChanges: false });
            });
        }
        useClipStore.getState().clearClipOverrides(constituentIds);
        setIsOverwriteDialogOpen(false);
        toast.success("Applied group settings to all clips in this group.");
    };

    return (
        <div className="w-full px-2 sm:px-3 xl:px-4 pt-4 sm:pt-5 flex flex-col gap-4 space-y-1">
            <div>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2">
                        <Label className="block text-sm/tight leading-3 text-zinc-200 font-normal tracking-[-0.0125rem]">
                            Silence Detection
                        </Label>
                        {isLocalView && (
                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-sky-950/60 text-sky-400 border border-sky-800/60">
                                Local View
                            </span>
                        )}
                    </div>

                    {isGroup && activeDisplayClip && (
                        <div className="flex items-center gap-2">
                            {isLocalView && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"
                                    onClick={() => setBypassed(!bypassed)}
                                    className={cn(
                                        "h-8 px-2.5 text-xs flex items-center gap-1.5 border transition-colors cursor-pointer",
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
                            )}

                            <Select value={selectValue} onValueChange={handleSelectChange}>
                                <SelectTrigger className="h-8 min-w-44 max-w-64">
                                    <SelectValue placeholder="Select view..." />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={activeDisplayClip.id}>
                                        <span className="font-medium">Combined Overview</span>
                                    </SelectItem>
                                    <SelectSeparator />
                                    {constituentItems.map((item) => {
                                        const itemParams = useClipStore.getState().parameters[item.id];
                                        const isItemBypassed = Boolean(itemParams?.bypassed);
                                        const isItemOverridden = Object.prototype.hasOwnProperty.call(
                                            useClipStore.getState().parameters,
                                            item.id
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
                                                    <span className="text-sky-400 text-[10px] ml-1.5 font-medium">
                                                        (Custom)
                                                    </span>
                                                ) : null}
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>
                <Separator aria-orientation="horizontal" className="h-px bg-zinc-700/80" />
            </div>

            <div className="relative">
                <div
                    className={cn(
                        "flex flex-wrap gap-6 lg:flex-row lg:items-start lg:gap-6 justify-between transition-all duration-200",
                        !isLocalView && isGroup && hasOverrides && "opacity-25 pointer-events-none select-none blur-[0.4px]"
                    )}
                >
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

                {!isLocalView && isGroup && hasOverrides && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-3 rounded-xl bg-zinc-950/40 backdrop-blur-[1px]">
                        <div className="flex flex-col items-center text-center p-4 bg-zinc-900/95 border border-zinc-700/80 rounded-xl shadow-2xl max-w-sm">
                            <p className="text-xs text-zinc-300 mb-3 leading-relaxed">
                                Individual clips in this group have customized settings applied in Local View.
                            </p>
                            <Button
                                type="button"
                                onClick={handleOverwriteClick}
                                className="bg-orange-600 hover:bg-orange-500 text-white font-medium shadow-md text-xs px-4 py-2 flex items-center gap-2 cursor-pointer transition-colors"
                            >
                                <LayersIcon className="h-3.5 w-3.5" />
                                Overwrite per-clip changes
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            <AlertDialog open={isOverwriteDialogOpen} onOpenChange={setIsOverwriteDialogOpen}>
                <AlertDialogContent className="max-w-md bg-zinc-900 border-zinc-700 text-zinc-100">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="text-base text-zinc-100">
                            Overwrite per-clip changes?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-xs text-zinc-400 leading-relaxed">
                            You have customized silence detection settings or bypass states for individual clips in this group.
                            Overwriting will discard these per-clip customizations and apply the group's Combined Overview settings to all clips in this group.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex items-center space-x-2 py-3">
                        <Checkbox
                            id="dont-show-overwrite-again"
                            checked={dontShowAgain}
                            onCheckedChange={(checked) => setDontShowAgain(Boolean(checked))}
                        />
                        <Label
                            htmlFor="dont-show-overwrite-again"
                            className="text-xs text-zinc-300 font-normal cursor-pointer select-none"
                        >
                            Don't show this again
                        </Label>
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel className="text-xs border-zinc-700 hover:bg-zinc-800">
                            Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleConfirmOverwrite}
                            className="text-xs bg-orange-600 hover:bg-orange-500 text-white"
                        >
                            Overwrite Changes
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};