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
                className="w-screen h-full min-w-full min-h-full pt-20 border border-zinc-950 rounded-none"
                style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
                disableRadixAnimations={dialogOpacity === 0}
                hideCloseButton={true}
                disableOutsideClick={true}
            >
                <DialogHeader className="">
                    <DialogTitle className="text-gray-200 pointer-events-none select-none">Settings</DialogTitle>
                    <DialogDescription>
                    </DialogDescription>
                </DialogHeader>


                <div className="grid gap-4 h-max max-w-6xl mx-auto select-none text-sm">
                    <h2 className="font-medium tracking-tight text-base">General</h2>
                    <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground">
                            <span className="block truncate">DaVinci Path</span>
                        </Label>
                        <div
                            className="col-span-2 w-full overflow-hidden border px-4 py-2 rounded-md text-gray-400"
                        >
                            <span className="block truncate pointer-events-auto select-text text-sm">{davinciFolderPath || "(default path)"}</span>
                        </div>
                        <Button
                            onClick={handleSelectFolder}
                            className="col-span-1 text-center whitespace-normal wrap-break-word leading-tight p-2 py-2.5 h-auto gap-1"
                            variant={"secondary"}
                        >
                            Select<span className="hidden sm:inline">Folder</span>

                        </Button>
                    </div>
                    <Separator className="relative block w-full min-h-full h-px bg-gray-700" />
                    <div className={cn(
                        "space-y-4",
                        enableCleanup ? "opacity-100" : "opacity-30"
                    )}>
                        <div className="flex gap-4">
                            <div className="grid grid-cols-4 items-center gap-4">
                                <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground">
                                    <span className="block text-left">UI Scale</span>
                                </Label>
                                <div className="flex gap-4 w-full min-w-lg items-center">
                                    <SquareMinusIcon className="w-5" onClick={zoomOut} />
                                    {currUiScale}
                                    <SquarePlusIcon className="w-5" onClick={zoomIn} />
                                </div>
                            </div>
                        </div>
                    </div>
                    <Separator className="relative block w-full min-h-full h-px bg-gray-700" />
                    <Label> <Switch checked={enableCleanup} onCheckedChange={setEnableCleanup} />Clean up Temp Files</Label>
                    <div className={cn(
                        "space-y-4",
                        enableCleanup ? "opacity-100" : "opacity-30"
                    )}>
                        <p className="text-zinc-400 text-sm text-balance">HushCut creates temp wav files to extract silence data and display the waveform preview. Files that haven't been accessed in a while will automatically get deleted before the app exits.</p>
                        <div className="flex gap-4">
                            <div className="grid grid-cols-4 items-center gap-4">
                                <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground">
                                    <span className="block text-left">Delete after</span>
                                </Label>
                                <div className="flex gap-4 w-full min-w-lg">
                                    <SliderZag className="w-32" value={[cleanupThreshold]} min={0} max={30} step={1} onChange={(values) => setCleanupThreshold(values[0])} disabled={!enableCleanup} />
                                    {cleanupThreshold} days</div>
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
