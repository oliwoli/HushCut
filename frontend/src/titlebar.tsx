import { CloseApp, SetWindowAlwaysOnTop } from "@wails/go/main/App";
import { XIcon, Ellipsis, PinIcon, ExternalLink, Info, Heart } from "lucide-react";
import { Button } from "./components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogClose,
} from "@/components/ui/dialog"

import { memo, useState } from "react";
import { BrowserOpenURL } from "@wails/runtime/runtime";

import { useUiStore } from "@/stores/uiStore";

const _TitleBar = () => {
    const [alwaysOnTop, setAlwaysOnTop] = useState<boolean>(true)

    // This function will handle the logic
    const handlePinClick = () => {
        const newAlwaysOnTopState = !alwaysOnTop;
        // Update the React state for instant UI feedback
        setAlwaysOnTop(newAlwaysOnTopState);
        // Call the Wails backend function to change the actual window state
        SetWindowAlwaysOnTop(newAlwaysOnTopState);
    }

    const { setInfoDialogOpen } = useUiStore();


    const handleDonateClick = () => {
        BrowserOpenURL("https://example.com/")
    }

    return (
        <div className="select-none">
            <div id="draggable" className="select-none">
                <div className="fixed top-0 select-none left-0 w-full draggable h-9 border-1 border-zinc-950 bg-[#212126] flex items-center justify-between px-1 z-[10] mb-20">
                    <div className="flex items-center space-x-2">
                        <Button
                            size={"sm"}
                            className="px-0 mx-0 bg-transparent hover:bg-transparent text-zinc-500 hover:text-white"
                            onClick={CloseApp}
                        >
                            <XIcon className="scale-90" strokeWidth={2.5} />
                        </Button>
                        <Button
                            size={"sm"}
                            className={`px-0 mx-0 bg-transparent hover:bg-transparent text-zinc-500 hover:text-zinc-200 scale-90 transition-colors duration-150 ${alwaysOnTop
                                ? 'text-teal-600 hover:text-teal-500' // Pinned style
                                : 'text-zinc-500'               // Default style
                                }`}
                            onClick={handlePinClick}
                        >
                            <PinIcon
                                // 2. Apply dynamic classes for styling
                                className={`${alwaysOnTop
                                    ? 'fill-teal-600 hover:fill-teal-200' // Pinned style
                                    : ''               // Default style
                                    }`}
                                strokeWidth={`${alwaysOnTop ? 1.5 : 2.5}`}
                            />
                        </Button>
                    </div>
                    <h1 className="text-sm font-normal text-neutral-200">HushCut</h1>
                    <div className="flex items-center">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="icon" className="bg-transparent hover:bg-transparent text-zinc-400 opacity-80 hover:text-zinc-300 hover:opacity-100">
                                    <Ellipsis className="h-8 w-8 text-xl scale-150 " />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="mr-1" align="end">
                                {/* <DropdownMenuLabel>Menu</DropdownMenuLabel> */}
                                {/* <DropdownMenuSeparator /> */}
                                <DropdownMenuItem onSelect={() => setInfoDialogOpen(true)}>
                                    <Info className="mr-2 h-4 w-4" />
                                    <span>Info</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={handleDonateClick}>
                                    <Heart className="mr-2 h-4 w-4" />
                                    <span className="flex-grow">Donate</span>
                                    <ExternalLink className="ml-4 h-4 w-4 opacity-70" />
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </div>


        </div>
    );
};

export const TitleBar = memo(_TitleBar);

function OpenURL(arg0: string) {
    throw new Error("Function not implemented.");
}
