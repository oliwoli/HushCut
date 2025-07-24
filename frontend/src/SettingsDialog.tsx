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

// This component is now "controlled" by its parent via these props.
interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const SettingsDialog = ({ open, onOpenChange }: SettingsDialogProps) => {
    const [internalOpen, setInternalOpen] = useState(false);
    const [dialogOpacity, setDialogOpacity] = useState(1);
    const [davinciFolderPath, setDavinciFolderPath] = useState("");

    useEffect(() => {
        if (open) {
            GetSettings().then((settings: any) => {
                setDavinciFolderPath(settings.davinciFolderPath);
            });
            setInternalOpen(true);
            setDialogOpacity(1);
        } else {
            setInternalOpen(false);
            setDialogOpacity(0);
            const fadeOutTimer = setTimeout(() => {
                // No need to set internalOpen here again
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
        SaveSettings({ davinciFolderPath }).then(() => {
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
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                    </DialogDescription>
                </DialogHeader>


                <div className="grid gap-4 h-max">
                    <Description>General</Description>
                    <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="davinci-folder-path" className="text-right text-muted-foreground">
                            <span className="block truncate">DaVinci Path</span>
                        </Label>
                        <Button
                            id="davinci-folder-path"
                            variant="outline"
                            className="col-span-2 w-full overflow-hidden"
                            onClick={handleSelectFolder}
                        >
                            <span className="block truncate">{davinciFolderPath || "Select a folder"}</span>
                        </Button>
                        <Button
                            onClick={handleSelectFolder}
                            className="col-span-1 text-center whitespace-normal break-words leading-tight p-2 py-2.5 h-auto gap-1"
                        >
                            Select<span className="hidden sm:inline">Folder</span>

                        </Button>
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
