// ThresholdControl.tsx
import React from 'react';
import { ThresholdSlider } from "@/components/ui-custom/volumeSlider";
import { useClipStore, useClipParameter, defaultParameters } from '@/stores/clipStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Label } from '../ui/label';
import { InfoIcon } from 'lucide-react';
import { DropdownMenuSeparator, Separator } from '@radix-ui/react-dropdown-menu';

interface ThresholdControlProps {
}


const _ThresholdControl: React.FC<ThresholdControlProps> = () => {
    const clipId = useClipStore(s => s.currentClipId);
    if (!clipId) return null
    const [threshold, setThreshold] = useClipParameter("threshold");

    return (
        <div className="h-full">
            <ThresholdSlider
                defaultDb={threshold}
                onGainChange={setThreshold}
                onDoubleClick={() => {
                    console.log("default threshold:", defaultParameters.threshold)
                    setThreshold(defaultParameters.threshold);
                }}

            />
            <div className="h-[40px] flex flex-col items-center text-center mt-0 text-base/tight text-zinc-400 hover:text-zinc-300 pl-2 pt-3 pr-0">
                <Tooltip delayDuration={950}>
                    <TooltipTrigger asChild>
                        <Label className="font-[185] text-stone-300 flex text-center gap-2 text-sm/tight">
                            Silence Threshold
                        </Label>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-[200px]'>
                        <h1 className='font-[600] tracking-tight'>Silence Threshold</h1>
                        <p>Audio louder than this threshold is considered <b>content</b>.</p>
                        <p>Anything below is considered <b>silence</b>.</p>
                        <Separator className='text-gray-800 h-px w-full bg-zinc-300 mb-1 mt-2 rounded-full' />
                        <p>Use the Silence Detection sliders below to fine tune.</p>

                    </TooltipContent>
                </Tooltip>

                <span className="text-xs text-zinc-100 whitespace-nowrap font-mono tracking-tighter mt-1">
                    {threshold.toFixed(2)} <span className="opacity-80">dB</span>
                </span>
            </div>
        </div>
    );
};

export const ThresholdControl = React.memo(_ThresholdControl);
