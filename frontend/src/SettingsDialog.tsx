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
import { Description } from "@radix-ui/react-dialog";
import { Switch } from "./components/ui/switch";
import { Separator } from "@radix-ui/react-context-menu";
import SliderZag from "./components/ui/sliderZag";
import { cn } from "./lib/utils";

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

    useEffect(() => {
        if (open) {
            GetSettings().then((settings: any) => {
                setDavinciFolderPath(settings.davinciFolderPath);
                setCleanupThreshold(settings.cleanupThresholdDays !== undefined ? settings.cleanupThresholdDays : 30);
                setEnableCleanup(settings.enableCleanup !== undefined ? settings.enableCleanup : true);
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

    const handleSelectFolder = async () => {
        const path = await SelectDirectory();
        if (path) {
            setDavinciFolderPath(path);
        }
    };

    const handleSave = () => {
        SaveSettings({ davinciFolderPath, cleanupThresholdDays: cleanupThreshold, enableCleanup }).then(() => {
            onOpenChange(false);
        });
    };

    if (!internalOpen) return null;

    return (
        <Dialog open={internalOpen} onOpenChange={onOpenChange}>
            <DialogContent
                className="w-screen h-full min-w-full min-h-full pt-20 border-1 border-zinc-950 rounded-none"
                style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
                disableRadixAnimations={dialogOpacity === 0}
                hideCloseButton={true}
                disableOutsideClick={true}
            >
                <DialogHeader className="">
                    <DialogTitle className="text-gray-200">Settings</DialogTitle>
                    <DialogDescription>
                    </DialogDescription>
                </DialogHeader>


                <div className="grid gap-4 h-max max-w-6xl mx-auto select-none">
                    <h2 className="font-medium tracking-tight text-base">General</h2>
                    <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground">
                            <span className="block truncate">DaVinci Path</span>
                        </Label>
                        <div
                            className="col-span-2 w-full overflow-hidden border-1 px-4 py-2 rounded-md text-gray-400"
                        >
                            <span className="block truncate pointer-events-auto select-text text-sm">{davinciFolderPath || "(default path)"}</span>
                        </div>
                        <Button
                            onClick={handleSelectFolder}
                            className="col-span-1 text-center whitespace-normal break-words leading-tight p-2 py-2.5 h-auto gap-1"
                            variant={"secondary"}
                        >
                            Select<span className="hidden sm:inline">Folder</span>

                        </Button>
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
                                <div className="flex gap-4 w-full min-w-128">
                                    <SliderZag className="w-[128px]" value={[cleanupThreshold]} min={0} max={30} step={1} onChange={(values) => setCleanupThreshold(values[0])} disabled={!enableCleanup} />
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
