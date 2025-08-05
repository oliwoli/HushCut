// components/SilenceControls.tsx

import { useGlobalStore } from '@/stores/clipStore';
import React from 'react';
import { Switch } from "@/components/ui/switch"

// Import your reusable UI components
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { InfoIcon } from 'lucide-react';

const _MakeNewTimelineSetting = React.memo(() => {
    const makeNewTimeline = useGlobalStore(s => s.makeNewTimeline);
    const setMakeNewTimeline = useGlobalStore(s => s.setMakeNewTimeline);

    return (
        <div className='space-y-2'>
            <Tooltip delayDuration={350}>
                <Label className="font-normal text-xs w-full text-stone-400 flex text-center gap-2 leading-5">
                    New Timeline
                    <TooltipTrigger asChild>
                        <InfoIcon size={16} className='text-zinc-600/60 hover:text-teal-600' />
                    </TooltipTrigger>
                </Label>
                <TooltipContent className='max-w-[200px]'>
                    <h1 className='font-[600] tracking-tight'>New Timeline</h1>
                    <p>Apply the edits in a new timeline.</p>

                </TooltipContent>
            </Tooltip>
            <Switch checked={makeNewTimeline} onCheckedChange={setMakeNewTimeline} />

        </div>
    );
});

const _KeepSilenceSetting = React.memo(() => {
    const keepSilence = useGlobalStore(s => s.keepSilence);
    const setKeepSilence = useGlobalStore(s => s.setKeepSilence);

    return (
        <div className='space-y-2 mx-auto gap-2 justify-center'>
            <Label className="font-normal text-xs w-full text-stone-400 leading-5">
                Preserve Silences
            </Label>
            <Switch checked={keepSilence} onCheckedChange={setKeepSilence} />

        </div>
    );
});


export const DavinciSettings = () => {
    return (
        <div className="space-y-1 w-[12rem] md:w-[16rem] px-1 pt-1 pb-1 flex gap-4 leading-1">
            <_MakeNewTimelineSetting />
            <_KeepSilenceSetting />
        </div>
    );
}