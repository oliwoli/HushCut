// components/SilenceControls.tsx

import { useGlobalStore } from '@/stores/clipStore';
import React from 'react';
import { Switch } from "@/components/ui/switch"

// Import your reusable UI components
import { Label } from '@/components/ui/label';

const _MakeNewTimelineSetting = React.memo(() => {
    const makeNewTimeline = useGlobalStore(s => s.makeNewTimeline);
    const setMakeNewTimeline = useGlobalStore(s => s.setMakeNewTimeline);

    return (
        <div className='space-y-2'>
            <Label className="font-medium w-full text-stone-400 leading-5">
                New Timeline
            </Label>
            <Switch checked={makeNewTimeline} onCheckedChange={setMakeNewTimeline} />

        </div>
    );
});

const _KeepSilenceSetting = React.memo(() => {
    const keepSilence = useGlobalStore(s => s.keepSilence);
    const setKeepSilence = useGlobalStore(s => s.setKeepSilence);

    return (
        <div className='space-y-2 mx-auto gap-2 justify-center'>
            <Label className="font-medium w-full text-stone-400 leading-5">
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