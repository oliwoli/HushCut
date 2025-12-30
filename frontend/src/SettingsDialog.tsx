import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { GetSettings, SaveSettings, SelectDirectory } from "@wails/go/main/App";
import { Switch } from "./components/ui/switch";
import { Separator } from "@radix-ui/react-context-menu";
import SliderZag from "./components/ui/sliderZag";
import { clamp, cn } from "./lib/utils";
import { toast } from "sonner";
import { useUiStore } from "./stores/uiStore";
import { SquareMinusIcon, SquarePlusIcon } from "lucide-react";

// This component is now "controlled" by its parent via these props.
interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const SettingsDialog = ({ open, onOpenChange }: SettingsDialogProps) => {
    const [internalOpen, setInternalOpen] = useState(false);
    const [dialogOpacity, setDialogOpacity] = useState(1);
    const [davinciFolderPath, setDavinciFolderPath] = useState("");
    const [cleanupThreshold, setCleanupThreshold] = useState(14);
    const [enableCleanup, setEnableCleanup] = useState(true);

    const currUiScale = useUiStore((s) => s.uiScale);
    const setUiScale = useUiStore((s) => s.setUiScale);

    useEffect(() => {
        if (open) {
            GetSettings().then((settings: any) => {
                setDavinciFolderPath(settings.davinciFolderPath);
                setCleanupThreshold(settings.cleanupThresholdDays !== undefined ? settings.cleanupThresholdDays : 30);
                setEnableCleanup(settings.enableCleanup !== undefined ? settings.enableCleanup : true);
                setUiScale(settings.uiScale !== undefined ? settings.uiScale : 1.0)
            });
            setInternalOpen(true);
            setDialogOpacity(1);
        } else {
            setInternalOpen(false);
            setDialogOpacity(0);
            const fadeOutTimer = setTimeout(() => {
            }, 150);

            return () => clearTimeout(fadeOutTimer);
        }
    }, [open]);


    useEffect(() => {
        GetSettings().then((settings: any) => {
            setUiScale(settings.uiScale !== undefined ? settings.uiScale : 1.0)
        });
    }, []);

    const handleSelectFolder = async () => {
        const path = await SelectDirectory();
        if (path) {
            setDavinciFolderPath(path);
        }
    };

    const handleSave = () => {
        SaveSettings({ davinciFolderPath, cleanupThresholdDays: cleanupThreshold, enableCleanup, uiScale: currUiScale }).then(() => {
            onOpenChange(false);
        });
        toast.success("Your settings have been saved.")
    };

    if (!internalOpen) return null;

    const SCALE_STEPS = [
        0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0,
        1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0
    ];
    const zoomIn = () => {
        const currentIndex = SCALE_STEPS.indexOf(currUiScale);
        const newIndex = Math.min(currentIndex + 1, SCALE_STEPS.length - 1);
        const newUiScale = SCALE_STEPS[newIndex];
        setUiScale(newUiScale);
    };

    const zoomOut = () => {
        const currentIndex = SCALE_STEPS.indexOf(currUiScale);
        const newIndex = Math.max(currentIndex - 1, 0);
        const newUiScale = SCALE_STEPS[newIndex];
        setUiScale(newUiScale)
    }

    return (
        <Dialog open={internalOpen} onOpenChange={onOpenChange}>
            <DialogContent
                className="w-screen h-screen min-w-full max-w-2xl pt-12 [@media(min-height:32rem)_and_(min-width:25rem)]:pt-20 border border-zinc-950 rounded-none"
                style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
                disableRadixAnimations={dialogOpacity === 0}
                hideCloseButton={true}
                disableOutsideClick={true}
            >

                <div className="flex-1 overflow-y-auto pr-2">
                    <div className="grid gap-4 h-max max-w-6xl mx-auto select-none text-sm">
                        <DialogHeader className="max-w-2xl">
                            <DialogTitle className="text-gray-200 pointer-events-none select-none font-extralight text-base [@media(min-height:32rem)_and_(min-width:25rem)]:text-xl">Settings</DialogTitle>
                            <DialogDescription>
                            </DialogDescription>
                        </DialogHeader>
                        <h2 className="font-medium tracking-tight text-base">General</h2>

                        {/* DAVINCI PATH */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                            <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground w-24 shrink-0 sm:text-right">
                                DaVinci Path
                            </Label>
                            <div className="flex flex-1 min-w-[200px] gap-2">
                                <div
                                    className="flex-1 max-w-xs overflow-hidden border px-4 py-2 rounded-md text-gray-400"
                                >
                                    <span className="block truncate pointer-events-auto select-text text-sm">{davinciFolderPath || "(default path)"}</span>
                                </div>
                                <Button
                                    onClick={handleSelectFolder}
                                    className="text-center whitespace-normal wrap-break-word leading-tight p-2 py-2.5 h-auto gap-1"
                                    variant={"secondary"}
                                >
                                    Select<span className="hidden sm:inline">Folder</span>

                                </Button>
                            </div>
                        </div>
                        <Separator className="h-px w-full bg-gray-700 my-2" />
                        {/* UI SCALE */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                            <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground w-24">
                                <span className="flex truncate w-xl">UI Scale</span>
                            </Label>
                            <div className="flex gap-4 items-center">
                                <SquareMinusIcon className="w-5" onClick={zoomOut} />
                                {currUiScale}
                                <SquarePlusIcon className="w-5" onClick={zoomIn} />
                            </div>
                        </div>

                        <Separator className="h-px w-full bg-gray-700 my-2" />

                        {/* CLEAN TEMP FILES */}
                        <Label> <Switch checked={enableCleanup} onCheckedChange={setEnableCleanup} />Clean up Temp Files</Label>
                        <div className={cn(
                            "space-y-4",
                            enableCleanup ? "opacity-100" : "opacity-30"
                        )}>
                            <p className="text-zinc-400 text-sm text-balance">HushCut creates temp wav files to extract silence data and display the waveform preview. Files that haven't been accessed in a while will automatically get deleted before the app exits.</p>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                                {/* Label: Fixed width on larger screens, auto on tiny screens */}
                                <Label
                                    htmlFor="cleanup-slider"
                                    className="text-muted-foreground w-24 shrink-0 sm:text-right"
                                >
                                    Delete after
                                </Label>

                                {/* Slider Container: flex-1 allows it to scale; min-w ensures it doesn't get too tiny */}
                                <div className="flex items-center gap-4 flex-1 min-w-48">
                                    <SliderZag
                                        id="cleanup-slider"
                                        className="flex-1 max-w-48" // flex-1 makes it scale down horizontally
                                        value={[cleanupThreshold]}
                                        min={0}
                                        max={30}
                                        step={1}
                                        onChange={(values) => setCleanupThreshold(values[0])}
                                        disabled={!enableCleanup}
                                    />
                                    <span className="whitespace-nowrap tabular-nums">
                                        {cleanupThreshold} days
                                    </span>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>

                <DialogFooter className="sm:items-end">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button onClick={handleSave}>Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
