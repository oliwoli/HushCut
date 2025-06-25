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

// This component is now "controlled" by its parent via these props.
interface InfoDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const InfoDialog = ({ open, onOpenChange }: InfoDialogProps) => {
    useEffect(() => setMounted(true), [])
    const [md, setMd] = useState('')


    useEffect(() => {
        fetch('/ffmpeg-notice.md')
            .then((res) => res.text())
            .then(setMd)
    }, [])

    console.log(md)

    const [mounted, setMounted] = useState(false)
    if (!mounted) return null
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl md:max-w-2xl xl:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>HushCut</DialogTitle>
                    <DialogDescription>
                        Version 1.0.0 (Alpha) - {new Date().getFullYear()}
                    </DialogDescription>
                </DialogHeader>

                <div className="text-sm text-muted-foreground space-y-4">
                    {/* <p>A simple, efficient application built with Wails and React.</p> */}
                    {md && (
                        <ScrollArea className="max-h-[60vh] overflow-y-auto pr-2">
                            <h3 className="font-bold text-foreground mt-4 mb-2">License</h3>
                            <p>All rights reserved.</p>
                            <div className="prose prose-sm dark:prose-invert max-w-none mt-4 max-h-2xl">
                                <MarkdownRenderer markdown={md} />
                            </div>
                        </ScrollArea>
                    )}
                </div>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button type="button">Close</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};