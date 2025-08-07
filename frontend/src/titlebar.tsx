import { CloseApp, SetWindowAlwaysOnTop } from "@wails/go/main/App";
import { XIcon, Ellipsis, PinIcon, ExternalLink, Info, Heart, CircleIcon, Settings2Icon } from "lucide-react";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"


import { memo, useState, useEffect } from "react";
import { BrowserOpenURL } from "@wails/runtime/runtime";

import { useUiStore } from "@/stores/uiStore";
import { useAppState } from "./stores/appSync";
import clsx from "clsx";

const _TitleBar = () => {
  const [alwaysOnTop, setAlwaysOnTop] = useState<boolean>(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [dropdownOpacity, setDropdownOpacity] = useState(1);

  useEffect(() => {
    if (dropdownOpen) {
      setDropdownVisible(true);
      setDropdownOpacity(1);
    } else {
      setDropdownOpacity(0);
      setDropdownVisible(false);
    }
  }, [dropdownOpen]);

  const isBusy = useAppState(s => s.isBusy);
  const hasProjectData = useAppState(s => s.hasProjectData);
  const timelineName = useAppState(s => s.timelineName);


  // This function will handle the logic
  const handlePinClick = () => {
    const newAlwaysOnTopState = !alwaysOnTop;
    // Update the React state for instant UI feedback
    setAlwaysOnTop(newAlwaysOnTopState);
    // Call the Wails backend function to change the actual window state
    SetWindowAlwaysOnTop(newAlwaysOnTopState);
  };

  const setInfoDialogOpen = useUiStore((s) => s.setInfoDialogOpen);
  const setSettingsDialogOpen = useUiStore((s) => s.setSettingsDialogOpen);

  const handleDonateClick = () => {
    BrowserOpenURL("https://buymeacoffee.com/hushcut");
  };


  return (
    <div className="select-none">
      <div id="draggable" className="select-none">
        <div className="fixed top-0 select-none left-0 w-full draggable h-9 border-1 border-zinc-950 bg-[#212126] flex items-center justify-between px-1 z-[10]">
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
              className={`group px-0 mx-0 bg-transparent hover:bg-transparent text-zinc-500 scale-90 transition-colors duration-50 ${alwaysOnTop
                ? "text-teal-600 hover:text-zinc-100" // Pinned style
                : "text-zinc-500 hover:text-zinc-200 " // Default style
                }`}
              onClick={handlePinClick}
            >
              <PinIcon
                // 2. Apply dynamic classes for styling
                className={`${alwaysOnTop
                  ? "fill-teal-600 group-hover:fill-teal-200" // Pinned style
                  : "" // Default style
                  }`}
                strokeWidth={`${alwaysOnTop ? 1.8 : 2.5}`}
              />
            </Button>
          </div>
          <div className="flex items-center gap-2 select-none">
            <h1 className="text-sm font-normal text-neutral-200 flex gap-1.5 items-baseline select-none">HushCut
            </h1>
            <CircleIcon
              size={8}
              className={clsx(
                'stroke-0', // always applied
                !hasProjectData && 'fill-red-600',
                hasProjectData && isBusy && 'fill-yellow-200/80 drop-shadow-[0_0_5px_rgba(251,191,36,0.1)] drop-shadow-red-300/50',
                hasProjectData && !isBusy && 'fill-teal-600'
              )}
            />
            {timelineName && (
              <span className="text-neutral-500 text-xs ">{timelineName}</span>
            )}

          </div>
          <div className="flex items-center">
            <DropdownMenu onOpenChange={setDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  className="bg-transparent hover:bg-transparent text-zinc-400 opacity-80 hover:text-zinc-300 hover:opacity-100"
                >
                  <Ellipsis className="h-8 w-8 text-xl scale-150 " />
                </Button>
              </DropdownMenuTrigger>
              {dropdownVisible && (
                <DropdownMenuContent
                  className="mr-1"
                  align="end"
                  style={{ opacity: dropdownOpacity, transition: 'opacity 150ms ease-in-out' }}
                  disableRadixAnimations={dropdownOpacity === 0}
                >
                  {/* <DropdownMenuLabel>Menu</DropdownMenuLabel> */}
                  {/* <DropdownMenuSeparator /> */}
                  <DropdownMenuItem onSelect={() => setSettingsDialogOpen(true)}>
                    <Settings2Icon className="mr-2 h-4 w-4" />
                    <span>Settings</span>
                  </DropdownMenuItem>
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
              )}
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
};

export const TitleBar = memo(_TitleBar);