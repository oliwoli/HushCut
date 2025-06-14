import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@radix-ui/react-context-menu"
import { CloseApp } from "@wails/go/main/App"
import { XIcon, Ellipsis } from "lucide-react"
import { Button } from "../ui/button"
import { memo } from "react"

const _TitleBar = () => {
    return (
        <ContextMenu>
            <ContextMenuTrigger>
                <div id="draggable">
                    <div className="fixed top-0 select-none left-0 w-full draggable h-9 border-1 border-zinc-950 bg-[#212126] flex items-center justify-between px-1 z-[10] mb-20">
                        <Button
                            size={"sm"}
                            className="px-0 mx-0 bg-transparent hover:bg-transparent text-zinc-500 hover:text-white"
                            onClick={CloseApp}
                        >
                            <XIcon className="scale-90" strokeWidth={2.5} />
                        </Button>
                        <h1 className="text-sm font-normal text-neutral-200">HushCut</h1>
                        <div className="flex items-center space-x-2">
                            <Button
                                size="icon"
                                className="bg-transparent hover:text-white hover:bg-transparent"
                            >
                                <Ellipsis className="h-8 w-8 text-xl scale-150 text-zinc-400 opacity-80 hover:text-blue-500 hover:opacity-100" />
                            </Button>
                        </div>
                    </div>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-64">
                <ContextMenuItem onClick={CloseApp}>
                    Close
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    )
}

export const TitleBar = memo(_TitleBar)