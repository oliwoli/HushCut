// src/components/InfoDialog.tsx

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@radix-ui/react-scroll-area";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { useEffect, useState } from "react";
import { GetAppVersion, GetFfmpegVersion } from "@wails/go/main/App";
import { CopyrightIcon, ExternalLinkIcon } from "lucide-react";
import { BrowserOpenURL } from "@wails/runtime/runtime";

import logo from "./assets/images/hc-512.png"

// This component is now "controlled" by its parent via these props.
interface InfoDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const InfoDialog = ({ open, onOpenChange }: InfoDialogProps) => {
    const [appVersion, setAppVersion] = useState("Unknown");
    const [ffmpegVersion, setFfmpegVersion] = useState("Unknown");
    const [md, setMd] = useState('');
    const [internalOpen, setInternalOpen] = useState(false); // Controls the Dialog's 'open' prop
    const [dialogOpacity, setDialogOpacity] = useState(1); // Controls the DialogContent's opacity

    useEffect(() => {
        if (open) { // Parent wants to open
            setInternalOpen(true);
            setDialogOpacity(1);
        } else { // Parent wants to close
            setDialogOpacity(0); // Start fading out

            const fadeOutTimer = setTimeout(() => {
                setInternalOpen(false);
                // No need to set internalOpen here again
            }, 150);

            return () => clearTimeout(fadeOutTimer);
        }
    }, [open]);

    useEffect(() => {
        fetch('/ffmpeg-notice.md')
            .then((res) => res.text())
            .then(setMd);

        GetAppVersion().then((version: string) => {
            setAppVersion(version);
        });
        GetFfmpegVersion().then((version: string) => {
            setFfmpegVersion(version);
        });
    }, []);

    const discordLink = "https://discord.gg/uFa8ExK7b8"
    const githubRepoLink = "https://github.com/oliwoli/hushcut-releases/releases"

    // Only render the Dialog if internalOpen is true
    if (!internalOpen) return null;

    return (
        <Dialog open={internalOpen} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-xl md:max-w-2xl xl:max-w-5xl"
                style={{ opacity: dialogOpacity, transition: 'opacity 150ms ease-in-out' }}
                disableRadixAnimations={dialogOpacity === 0}
                disableOutsideClick={true}
            >
                <div className="flex gap-4 items-center h-10 overflow-visible select-none pointer-events-none">
                    <div className="w-20 h-20 ml-[-15px] mr-[-18px] mt-[-10px]">
                        <img src={logo} alt="HushCut Logo" className="w-22 h-22" />
                    </div>
                    <DialogHeader className="gap-1 pt-[5px]">
                        <DialogTitle>HushCut</DialogTitle>
                        <DialogDescription>
                            v{appVersion} - {new Date().getFullYear()}
                        </DialogDescription>
                    </DialogHeader>
                </div>

                <div className="text-sm text-muted-foreground space-y-4">
                    {/* <p>A simple, efficient application built with Wails and React.</p> */}
                    {md && (
                        <ScrollArea className="max-h-[60vh] overflow-y-auto pr-2">
                            <h3 className="font-normal text-foreground mt-4 mb-2">License</h3>
                            <p className="flex items-center gap-1"><CopyrightIcon size={14} className="" /> Oliver Weiss | All rights reserved.</p>
                            <h1 className="font-extralight text-foreground mt-8 mb-1 text-2xl">Found a bug, want to share feedback, or just chat?</h1>
                            <p>Join our <b className="font-[350] text-zinc-200">discord server</b></p>
                            <a href="#" onClick={() => discordLink && BrowserOpenURL(discordLink)} className="text-orange-400 flex gap-1 underline">{discordLink}<ExternalLinkIcon className='h-4 text-gray-400' strokeWidth={1.5} /></a>
                            <h3 className="font-extralight text-foreground mt-8 mb-1 text-2xl">All Releases</h3>
                            <p>Compiled binaries for Windows, MacOS and Linux can be found on:</p>
                            <a href="#" onClick={() => githubRepoLink && BrowserOpenURL(githubRepoLink)} className="text-orange-400 flex gap-1 underline">{githubRepoLink}<ExternalLinkIcon className='h-4 text-gray-400' strokeWidth={1.5} /></a>

                            <p className="font-extralight mt-12 mb-1"><span className="text-foreground font-[350]">FFmpeg version</span> v{ffmpegVersion}</p>
                            <div className="prose prose-sm dark:prose-invert max-w-none max-h-2xl">
                                <MarkdownRenderer markdown={md} />
                            </div>
                        </ScrollArea>
                    )}
                </div>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button type="button" variant={"outline"}>Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};