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
            <Label className="font-medium w-32 text-stone-400">
                Make new Timeline
            </Label>
            <Switch checked={makeNewTimeline} onCheckedChange={setMakeNewTimeline} />

        </div>
    );
});

export const DavinciSettings = () => {
    return (
        <div className="space-y-6 w-full p-5">
            <_MakeNewTimelineSetting />
        </div>
    );
}