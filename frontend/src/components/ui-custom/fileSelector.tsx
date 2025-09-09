// ./components/ui/fileSelector.tsx
import React, { useState, useEffect, useMemo, useRef, memo, useCallback } from "react";
import { cn, frameToTimecode } from "@/lib/utils";
import { main } from "@wails/go/models";
import { GetWaveform } from "@wails/go/main/App";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Progress } from "../ui/progress";
import { AlignJustifyIcon, AsteriskIcon, AudioLinesIcon, LayersIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { useClipStore, useIsClipModified } from "@/stores/clipStore";
import { useVirtualizer } from '@tanstack/react-virtual';
import { useProgressStore } from "@/stores/progressStore";

// Icon for the empty state
const AudioFileIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("h-5 w-5", className)}>
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);
const SimulatedWaveform = memo(({ className }: { className?: string }) => (
  <svg viewBox="0 0 200 50" preserveAspectRatio="none" className={cn("w-full h-full", className)}>
    <path d="M 0 25 L 10 15 L 20 35 L 30 10 L 40 40 L 50 20 L 60 30 L 70 15 L 80 35 L 90 5 L 100 45 L 110 25 L 120 10 L 130 40 L 140 20 L 150 30 L 160 15 L 170 35 L 180 10 L 190 40 L 200 25" stroke="currentColor" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
  </svg>
));

const generateWaveformJobKey = (fileName: string, start: number, end: number): string => {
  // Use toFixed() to prevent inconsistencies from floating point numbers
  return `${fileName}|${start.toFixed(3)}|${end.toFixed(3)}`;
};


const LinearWaveform = memo(({ peaks, className }: { peaks: number[]; className?: string }) => {
  const width = 200;
  const height = 50;
  const pathData = useMemo(() => {
    if (!peaks || peaks.length === 0) return '';
    const centerY = 25;
    const stepX = width / peaks.length;
    let d = '';
    for (let i = 0; i < peaks.length; i++) {
      const x = i * stepX;
      const p = peaks[i];
      const y1 = centerY * (1 - p);
      const y2 = centerY * (1 + p);
      d += `M${x.toFixed(2)} ${y1.toFixed(2)} L${x.toFixed(2)} ${y2.toFixed(2)} `;
    }
    return d;
  }, [peaks]);

  if (!pathData) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full h-[80%]", className)}
    >
      <path d={pathData} stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
});

// Icon to represent a linked file
const ClipLinkIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("h-3 w-3", className)}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"></path>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"></path>
  </svg>
);
const TARGET_PEAK_COUNT = 64;
const ASSUMED_SAMPLE_RATE = 48000; // A reasonable assumption for video-related audio
const MIN_SAMPLES_PER_PIXEL = 128; // Ensures very short clips still have some detail


const waveformCache = new Map<string, number[]>();
const AudioClip = memo(({ item, index, isSelected, onClipClick, disabled, fps, allClipIds, forwardedRef }: {
  item: main.TimelineItem;
  index: string;
  isSelected: boolean;
  onClipClick: (id: string) => void;
  disabled?: boolean;
  fps?: number;
  allClipIds: string[];
  forwardedRef: React.Ref<HTMLButtonElement>;
}) => {
  if (!fps) return null;

  // compute jobKey before state hooks
  const { startSeconds, endSeconds } = useMemo(() => {
    if (
      typeof item.source_start_frame !== "number" ||
      typeof item.source_end_frame !== "number" ||
      fps <= 0
    ) {
      return { startSeconds: 0, endSeconds: 0 };
    }
    const start =
      item.type === "Compound" ? 0 : item.source_start_frame;
    const end =
      item.type === "Compound"
        ? item.end_frame - item.start_frame
        : item.source_end_frame;
    return {
      startSeconds: start / fps,
      endSeconds: end / fps,
    };
  }, [item, fps]);

  const jobKey = useMemo(
    () =>
      item.processed_file_name
        ? generateWaveformJobKey(
          item.processed_file_name,
          startSeconds,
          endSeconds
        )
        : "",
    [item.processed_file_name, startSeconds, endSeconds]
  );

  // initialize from cache if present
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(
    () => waveformCache.get(jobKey) ?? null
  );
  const [isFetchingWaveform, setIsFetchingWaveform] = useState(false);

  // progress / error from zustand
  const progress = useProgressStore((s) =>
    item.processed_file_name
      ? s.conversionProgress[item.processed_file_name]
      : undefined
  );
  const hasError = useProgressStore((s) =>
    item.processed_file_name
      ? s.conversionErrors[item.processed_file_name]
      : false
  );
  const waveformProgress = useProgressStore((s) => s.waveformProgress[jobKey]);

  const isConverting =
    typeof progress === "number" && progress >= 0 && progress < 100;
  const isLoading = isConverting || isFetchingWaveform;
  const isModified = useIsClipModified(item.id);

  const bypassed = useClipStore((s) =>
    s.getParameter(item.id, "bypassed")
  );

  // bypass toggle
  const setBypassed = (val: boolean) =>
    useClipStore.getState().setParameter(item.id, "bypassed", val);

  // effect to fetch & cache waveform
  useEffect(() => {
    const clipDuration = endSeconds - startSeconds;
    if (
      waveformCache.has(jobKey) ||
      !item.processed_file_name ||
      clipDuration <= 0 ||
      isConverting
    ) {
      return;
    }

    let cancelled = false;
    setIsFetchingWaveform(true);

    const fetchWaveform = async () => {
      const dynamicSamplesPerPixel = Math.max(
        MIN_SAMPLES_PER_PIXEL,
        Math.ceil(
          (clipDuration * ASSUMED_SAMPLE_RATE) / TARGET_PEAK_COUNT
        )
      );

      try {
        // small debounce before actual call
        await new Promise((r) => setTimeout(r, 25));
        if (cancelled) return;

        const peakData = await GetWaveform(
          item.processed_file_name!,
          dynamicSamplesPerPixel,
          "linear",
          -60.0,
          startSeconds,
          endSeconds
        );
        if (!cancelled && peakData?.peaks) {
          waveformCache.set(jobKey, peakData.peaks);
          setWaveformPeaks(peakData.peaks);
        }
      } catch (e) {
        if (!cancelled)
          console.error("Waveform fetch failed for", item.name, e);
      } finally {
        if (!cancelled) setIsFetchingWaveform(false);
      }
    };

    fetchWaveform();
    return () => {
      cancelled = true;
    };
  }, [
    jobKey,
    item.processed_file_name,
    startSeconds,
    endSeconds,
    isConverting,
  ]);

  const handleClipClick = useCallback(
    () => onClipClick(item.id),
    [item.id, onClipClick]
  );

  const isNested = item.type !== null;

  const handleBypassClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // The new bypass value for *this* clip:
    const newBypass = !bypassed;

    if (e.shiftKey) {
      // Apply to *all* clips:
      allClipIds.forEach(id =>
        useClipStore.getState().setParameter(id, 'bypassed', newBypass)
      );
    } else {
      // Just this clip:
      setBypassed(newBypass);
    }
  };

  return (
    <div className={cn(
      "flex flex-col flex-shrink-0 max-w-44 min-w-24",
    )}>
      <div className="flex justify-between items-center text-xs text-zinc-500 font-mono pr-2 pb-1 [@media(max-height:800px)]:pb-0.5 space-x-2">
        <span className={cn(bypassed ? "text-stone-500" : "text-stone-200", " p-1 rounded-xs border-1 flex items-center")}>{index}</span>
        <span className="flex items-center gap-1">{frameToTimecode(item.start_frame, fps)}</span>
        <span className="flex items-center gap-0"><AlignJustifyIcon className="h-4 items-center text-gray-700" /> A{item.track_index}</span>
      </div>
      <button
        ref={forwardedRef} // ✨ Assign the forwarded ref here
        type="button"
        onClick={handleClipClick}
        disabled={disabled}
        className={cn(
          "group",
          "h-20 [@media(max-height:800px)]:h-16 text-left rounded-sm transition-all duration-150 ease-in-out overflow-hidden relative",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400",
          "border",
          bypassed ? "bg-none" : "bg-gray-700/40",
          {
            "border-zinc-700 hover:border-zinc-600": !isSelected,
            "border-orange-500 ": isSelected,
            "cursor-not-allowed opacity-60": disabled,
          }
        )}
      >
        {/* Progress Bar / Error Overlay */}
        {(isConverting || hasError) && (
          <div className="absolute inset-0 bg-black/60 z-20 flex items-center justify-center p-2">
            {hasError ? (
              <span className="text-xs text-red-400 font-semibold">Error</span>
            ) : (
              <Progress value={progress} />
            )}
          </div>
        )}

        {(!isConverting && isLoading) && (
          <div className="absolute inset-0 bg-black/10 z-20 flex items-top justify-center p-0">
            {hasError ? (
              <span className="text-xs text-red-400 font-semibold">Error</span>
            ) : (
              <Progress value={waveformProgress} className="rounded-none h-[2px] max-h-[2px] p-0" indicatorClassName="shadow-1 shadow-indigo-500 bg-teal-500 h-full w-full flex-1 transition-all" />
            )}
          </div>
        )}

        <div className={cn(
          bypassed ? "flex" : "group-hover:flex hidden",
          "text-zinc-400 z-30 top-0 right-1.5 p-2 pl-4 absolute items-center space-x-1",
          "hover:text-zinc-100"
        )} role="button" onClick={handleBypassClick}>
          {bypassed ? (
            <PowerOffIcon size={15} className="text-orange-400/60 hover:text-orange-200" />
          ) : (
            <PowerIcon size={15} />
          )}
        </div>


        <div className={cn(
          "absolute inset-0 flex items-center justify-center  p-1 bottom-6 [@media(max-height:800px)]:bottom-5",
          bypassed ? "text-gray-600/50" : "text-teal-600",
          isLoading && "animate-pulse")
        }>

          {isLoading ? <SimulatedWaveform /> : (
            waveformPeaks ?
              <LinearWaveform
                peaks={waveformPeaks}
              /> :
              <SimulatedWaveform />
          )}
        </div>
        <div className={cn(
          bypassed ? "opacity-35" : "opacity-100",
          "relative z-10 h-full flex flex-col justify-end p-2 pb-[0.450rem] [@media(max-height:800px)]:p-1.5 [@media(max-height:800px)]:pb-1 bg-gradient-to-t from-black/50 via-black/20 to-transparent"
        )}>
          <div className="flex items-center space-x-1.5">
            {isNested && (
              <LayersIcon className="text-sm h-[14px] text-stone-400 p-0 mr-1" />
            )}
            {!isNested && (
              <AudioLinesIcon className={cn("text-sm h-[14px] text-stone-400 p-0 mr-1")} />
            )}
            <div className={cn(

              "flex items-baseline space-x-1")}>
              <p className="font-normal text-xs text-zinc-200/90 truncate max-w-28">{item.name}</p>
              <span className={cn("text-orange-400 text-base", !isModified && "opacity-0")}><AsteriskIcon size={14} className="p-0 m-0 ml-[-4px] mb-[2px]" /></span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
});

interface FileSelectorProps {
  audioItems: main.TimelineItem[] | null | undefined; currentFileId: string | null;
  onFileChange: (selectedItemId: string) => void;
  disabled?: boolean;
  className?: string;
  fps?: number;
}

const _FileSelector: React.FC<FileSelectorProps> = ({
  audioItems,
  currentFileId,
  onFileChange,
  fps,
  disabled,
  className,
}) => {
  const sortedItems = useMemo(() => {
    if (!audioItems || audioItems.length === 0) return [];
    return [...audioItems]
      .sort((a, b) => {
        if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
        if (a.track_index !== b.track_index) return a.track_index - b.track_index;
        return a.end_frame - b.end_frame;
      });
  }, [audioItems]);

  const handleFileChange = useCallback((selectedItemId: string) => {
    onFileChange(selectedItemId);
  }, [onFileChange]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // ✨ Create a map to hold refs for each item's button
  const itemRefs = useRef(new Map<string, HTMLButtonElement | null>());

  if (sortedItems.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center p-8 bg-zinc-800/50 border-2 border-dashed border-zinc-700 rounded-sm", className)}>
        <AudioFileIcon className="h-10 w-10 text-zinc-500 mb-3" />
        <h3 className="font-semibold text-lg text-zinc-300">No Audio Items</h3>
        <p className="text-sm text-zinc-500">The timeline does not contain any audio clips.</p>
      </div>
    );
  }
  const columnVirtualizer = useVirtualizer({
    count: sortedItems.length,
    getScrollElement: () => scrollAreaRef.current?.querySelector('[data-slot="scroll-area-viewport"]') ?? null,
    estimateSize: () => 150,
    horizontal: true,
    overscan: 10,
    isScrollingResetDelay: 200,
    useScrollendEvent: false,
    useAnimationFrameWithResizeObserver: true,
  });


  // ✨ ADDED: Effect to scroll to and focus the selected clip
  useEffect(() => {
    if (!currentFileId) return;

    const selectedIndex = sortedItems.findIndex(item => item.id === currentFileId);

    if (selectedIndex !== -1) {
      // Scroll the item into the center of the view
      columnVirtualizer.scrollToIndex(selectedIndex, { align: 'center', behavior: 'smooth' });

      // Focus the button element after a short delay to allow for the scroll
      setTimeout(() => {
        const buttonEl = itemRefs.current.get(currentFileId);
        buttonEl?.focus({ preventScroll: true }); // preventScroll avoids a second jump
      }, 150); // Delay may need adjustment depending on scroll animation
    }
  }, [currentFileId, sortedItems, columnVirtualizer]);


  // Get the virtual items to render
  const virtualItems = columnVirtualizer.getVirtualItems();

  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element) return;

    const handleWheel = (e: globalThis.WheelEvent) => {
      // Find the scrollable viewport inside the component
      const viewport = element.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || e.deltaY === 0) return;

      // This will now work because the listener is not passive
      e.preventDefault();

      viewport.scrollBy({
        left: e.deltaY,
        behavior: 'auto', // 'auto' often feels more responsive than 'smooth' for wheel scrolling
      });
    };

    // Add the event listener with the crucial `{ passive: false }` option
    element.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const allClipIds = useMemo(() => sortedItems.map(item => item.id), [sortedItems]);

  return (
    <ScrollArea ref={scrollAreaRef} className={cn("w-full whitespace-nowrap pb-4 overflow-visible", className)}>
      <div
        className={cn(
          "relative h-[112px]",
          "[@media(max-height:800px)]:h-[95px]"
        )}
        style={{
          width: `${columnVirtualizer.getTotalSize()}px`,
        }}
      >
        {virtualItems.map((virtualItem) => {
          const item = sortedItems[virtualItem.index];
          const itemUniqueIdentifier = item.id || item.processed_file_name;
          if (!itemUniqueIdentifier) return null;

          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={columnVirtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: `${virtualItem.size}px`,
                transform: `translateX(${virtualItem.start}px)`,
                padding: '0 2px', // Use padding on the wrapper for spacing
              }}
            >
              <AudioClip
                // ✨ Pass the ref callback to the child component
                forwardedRef={(el) => { itemRefs.current.set(item.id, el); }}
                index={String(virtualItem.index + 1).padStart(String(sortedItems.length).length, '0')}
                item={item}
                isSelected={currentFileId === itemUniqueIdentifier}
                onClipClick={handleFileChange}
                disabled={disabled}
                fps={fps}
                allClipIds={allClipIds}
              />
            </div>
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};

const FileSelector = React.memo(_FileSelector);
export default FileSelector