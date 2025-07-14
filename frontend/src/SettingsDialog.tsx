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
            setDialogOpacity(0);
            const fadeOutTimer = setTimeout(() => {
                setInternalOpen(false);
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
                className="w-screen h-screen min-w-full pt-20"
                style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
                disableRadixAnimations={dialogOpacity === 0}
                hideCloseButton={true}
            >
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Configure HushCut to your needs.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-4 items-center gap-4">
                        <Label htmlFor="davinci-folder-path" className="text-right">
                            DaVinci Folder Path
                        </Label>
                        <Button
                            id="davinci-folder-path"
                            variant="outline"
                            className="col-span-2"
                            onClick={handleSelectFolder}
                        >
                            {davinciFolderPath || "Select a folder"}
                        </Button>
                        <Button onClick={handleSelectFolder} className="col-span-1">Select Folder</Button>
                    </div>
                </div>
                <DialogFooter>
                    <Button onClick={handleSave}>Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
