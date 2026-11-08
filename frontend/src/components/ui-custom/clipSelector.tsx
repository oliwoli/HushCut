// ./components/ui/fileSelector.tsx
import React, { useState, useEffect, useMemo, useRef, memo, useCallback, useLayoutEffect } from "react";
import { cn, frameToTimecode, truncateFilename } from "@/lib/utils";
import { main } from "@wails/go/models";
import { GetWaveform } from "@wails/go/main/App";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

import { Progress } from "../ui/progress";
import { AlignJustifyIcon, AsteriskIcon, AudioLinesIcon, CheckIcon, LayersIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { isConstituentClipOverridden, useClipStore, useIsClipModified } from "@/stores/clipStore";
import { useVirtualizer, VirtualItem, Virtualizer } from '@tanstack/react-virtual';
import { useProgressStore } from "@/stores/progressStore";
import { ContextMenuLabel } from "@radix-ui/react-context-menu";
import { DropdownMenuSeparator } from "../ui/dropdown-menu";
import { useUiStore } from "@/stores/uiStore";
import { DisplayClip, buildDisplayClips } from "@/lib/clipUtils";


function downsamplePeaks(fullPeaks: number[], targetPeakCount: number) {
  const step = fullPeaks.length / targetPeakCount;
  const out: number[] = [];
  for (let i = 0; i < targetPeakCount; i++) {
    const idx = Math.floor(i * step);
    out.push(fullPeaks[idx]);
  }
  return out;
}


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
const TARGET_PEAK_COUNT = 56;
const ASSUMED_SAMPLE_RATE = 48000;
const MIN_SAMPLES_PER_PIXEL = 128; // Ensures very short clips still have some detail


const waveformCache = new Map<string, number[]>();
const AudioClip = memo(({ clip, index, isSelected, onClipClick, disabled, fps, allClipIds, forwardedRef }: {
  clip: DisplayClip;
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
      typeof clip.source_start_frame !== "number" ||
      typeof clip.source_end_frame !== "number" ||
      fps <= 0
    ) {
      return { startSeconds: 0, endSeconds: 0 };
    }
    const start =
      clip.type === "Compound" ? 0 : clip.source_start_frame;
    const end =
      clip.type === "Compound"
        ? clip.end_frame - clip.start_frame
        : clip.source_end_frame;
    return {
      startSeconds: start / fps,
      endSeconds: end / fps,
    };
  }, [clip, fps]);

  const jobKey = useMemo(
    () =>
      clip.processed_file_name
        ? generateWaveformJobKey(
          clip.processed_file_name,
          startSeconds,
          endSeconds
        )
        : "",
    [clip.processed_file_name, startSeconds, endSeconds]
  );

  // initialize from cache if present
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(
    () => waveformCache.get(jobKey) ?? null
  );
  const [isFetchingWaveform, setIsFetchingWaveform] = useState(false);

  // progress / error from zustand
  const progress = useProgressStore((s) => {
    if (!clip.processed_file_name) return undefined;
    const selfProgress = s.conversionProgress[clip.processed_file_name];
    if (typeof selfProgress === "number" && selfProgress < 100) {
      return selfProgress;
    }
    if (clip.is_linked_group && clip.constituent_processed_file_names) {
      for (const fn of clip.constituent_processed_file_names) {
        const itemProg = s.conversionProgress[fn];
        if (typeof itemProg === "number" && itemProg < 100) {
          return itemProg;
        }
      }
    }
    return selfProgress;
  });
  const hasError = useProgressStore((s) => {
    if (!clip.processed_file_name) return false;
    if (s.conversionErrors[clip.processed_file_name]) return true;
    if (clip.is_linked_group && clip.constituent_processed_file_names) {
      for (const fn of clip.constituent_processed_file_names) {
        if (s.conversionErrors[fn]) return true;
      }
    }
    return false;
  });
  const waveformProgress = useProgressStore((s) => s.waveformProgress[jobKey]);

  const isConverting =
    typeof progress === "number" && progress >= 0 && progress < 100;
  const isLoading = isConverting || isFetchingWaveform;
  const isModified = useIsClipModified(clip.id);

  const bypassed = useClipStore((s) =>
    s.getParameter(clip.id, "bypassed")
  );
  const timelineItems = useClipStore((s) => s.timelineItems);
  const parameters = useClipStore((s) => s.parameters);
  const activeGroupViewId = useClipStore((s) => {
    if (!clip.is_linked_group) return clip.id;
    if (
      s.currentClipId === clip.id ||
      clip.constituent_item_ids.includes(s.currentClipId || "")
    ) {
      return s.currentClipId || clip.id;
    }
    return s.groupActiveView[clip.id] || clip.id;
  });

  const constituentItems = useMemo(() => {
    if (!clip.is_linked_group) return [];
    return clip.constituent_item_ids
      .map((id) => timelineItems[id])
      .filter((it): it is main.TimelineItem => Boolean(it))
      .sort((a, b) => a.track_index - b.track_index);
  }, [clip.is_linked_group, clip.constituent_item_ids, timelineItems]);

  const displayedClipName = useMemo(() => {
    if (clip.is_linked_group && activeGroupViewId !== clip.id) {
      const item = timelineItems[activeGroupViewId];
      if (item) {
        return item.name || `Clip on A${item.track_index}`;
      }
    }
    return clip.name;
  }, [clip.is_linked_group, clip.id, clip.name, activeGroupViewId, timelineItems]);

  // bypass toggle
  const setBypassed = (val: boolean) => {
    useClipStore.getState().setParameter(clip.id, "bypassed", val);
  };

  // effect to fetch & cache waveform
  useEffect(() => {
    const clipDuration = endSeconds - startSeconds;
    if (
      waveformCache.has(jobKey) ||
      !clip.processed_file_name ||
      clipDuration <= 0 ||
      isConverting
    ) {
      return;
    }

    let cancelled = false;
    setIsFetchingWaveform(true);

    const fetchWaveform = async () => {
      try {
        // small debounce before actual call
        await new Promise((r) => setTimeout(r, 25));
        if (cancelled) return;

        const fullResPeakData = await GetWaveform(
          clip.processed_file_name!,
          128,
          "linear",
          -60.0,
          startSeconds,
          endSeconds
        );
        if (!cancelled && fullResPeakData?.peaks) {
          const downsampledPeakData = downsamplePeaks(fullResPeakData.peaks, TARGET_PEAK_COUNT);
          waveformCache.set(jobKey, downsampledPeakData);
          setWaveformPeaks(downsampledPeakData);
        }
      } catch (e) {
        if (!cancelled)
          console.error("Waveform fetch failed for", clip.name, e);
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
    clip.processed_file_name,
    startSeconds,
    endSeconds,
    isConverting,
  ]);

  const handleClipClick = useCallback(
    () => onClipClick(clip.is_linked_group ? activeGroupViewId : clip.id),
    [clip.is_linked_group, clip.id, activeGroupViewId, onClipClick]
  );

  const isNested = clip.type && clip.type !== null && clip.type.length > 0;

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
    <ContextMenu>
      <div className={cn(
        "flex flex-col shrink-0 max-w-44 min-w-24 w-full",
      )}>
        <div className="flex justify-start items-center text-xs text-zinc-500 font-mono pr-2 pb-1 [@media(max-height:800px)]:pb-0.5 space-x-2">
          <span className={cn(bypassed ? "text-stone-500" : "text-stone-200", " p-1 rounded-xs border flex items-center")}>{index}</span>
          <span className="flex items-center gap-1 text-[0.6rem]">{frameToTimecode(clip.start_frame, fps)}</span>
          <span className="flex items-center gap-1">
            <AlignJustifyIcon className="h-4 items-center text-gray-700" /> {clip.track_label}
          </span>
        </div>

        <ContextMenuTrigger className="flex">
          <button
            ref={forwardedRef}
            type="button"
            onClick={handleClipClick}
            disabled={disabled}
            className={cn(
              "group",
              "h-20 [@media(max-height:800px)]:h-16 text-left rounded-sm transition-all duration-150 ease-in-out overflow-hidden relative",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400",
              "border",
              "w-full",
              bypassed ? "bg-none" : "bg-gray-700/40",
              {
                "border-zinc-700 hover:border-zinc-600": !isSelected,
                "border-orange-500 ": isSelected,
                "cursor-not-allowed opacity-60": disabled,
              }
            )}          >
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
                  <Progress value={waveformProgress} className="rounded-none h-0.5 max-h-0.5 p-0" indicatorClassName="shadow-1 shadow-indigo-500 bg-teal-500 h-full w-full flex-1 transition-all" />
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
              "relative z-10 h-full flex flex-col justify-end p-2 pb-[0.450rem] [@media(max-height:800px)]:p-1.5 [@media(max-height:800px)]:pb-1 bg-linear-to-t from-black/50 via-black/20 to-transparent"
            )}>
              <div className="flex items-center space-x-1.5">
                {clip.is_linked_group ? (
                  <span title={`Linked Audio (${clip.track_label})`} className="inline-flex items-center shrink-0 mr-1">
                    <ClipLinkIcon className="h-3.5 w-3.5 text-gray-300 p-0" />
                  </span>
                ) : isNested ? (
                  <LayersIcon className="text-sm h-3.5 text-stone-400 p-0 mr-1 shrink-0" />
                ) : (
                  <AudioLinesIcon className={cn("text-sm h-3.5 text-stone-400 p-0 mr-1 shrink-0")} />
                )}
                <div className={cn(
                  "flex items-baseline space-x-1")}>
                  <p className={cn(
                    "font-normal text-xs truncate max-w-28",
                    isSelected ? "text-zinc-200/90" : "text-gray-400"
                  )}>
                    {truncateFilename(displayedClipName)}</p>
                  <span className={cn("text-orange-400 text-base", !isModified && "opacity-0")}><AsteriskIcon size={14} className="absolute left-0.5 top-0.5" /></span>
                </div>
              </div>
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="text-xs text-gray-300">
          {clip.is_linked_group && (
            <>
              <ContextMenuItem
                className="text-xs"
                onClick={() => onClipClick(clip.id)}
              >
                {activeGroupViewId === clip.id ? (
                  <CheckIcon className="w-[1.25em] h-[1.25em]" />
                ) : (
                  <div className="w-[1.25em]" />
                )}
                <span className="font-medium">Combined Overview</span>
              </ContextMenuItem>
              <DropdownMenuSeparator />
              {constituentItems.map((item) => {
                const itemParams = parameters[item.id];
                const isItemBypassed = Boolean(itemParams?.bypassed);
                const isItemOverridden = isConstituentClipOverridden(
                  item.id,
                  parameters
                );
                const isActiveView = activeGroupViewId === item.id;
                return (
                  <ContextMenuItem
                    key={item.id}
                    className="text-xs"
                    onClick={() => onClipClick(item.id)}
                  >
                    {isActiveView ? (
                      <CheckIcon className="w-[1.25em] h-[1.25em]" />
                    ) : (
                      <div className="w-[1.25em]" />
                    )}
                    <span className="text-zinc-400 font-mono text-[11px]">
                      A{item.track_index}
                    </span>
                    <span className="truncate">
                      {item.name || `Clip on A${item.track_index}`}
                    </span>
                    {isItemBypassed ? (
                      <span className="text-orange-400 text-[10px] font-medium">
                        (Bypassed)
                      </span>
                    ) : isItemOverridden ? (
                      <span className="text-teal-400 text-[10px] font-medium">
                        (Custom)
                      </span>
                    ) : null}
                  </ContextMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </>
          )}
          <ContextMenuItem className="text-xs" onClick={handleBypassClick}>
            {bypassed ? (
              <CheckIcon className="w-[1.25em] h-[1.25em]" />
            ) : (
              <div className="w-[1.25em]" />
            )}
            Bypass Clip
          </ContextMenuItem>
          <DropdownMenuSeparator />
          {!clip.is_linked_group ? (
            <ContextMenuLabel className="text-[0.65rem] font-extralight text-gray-400">
              {clip.name}
            </ContextMenuLabel>
          ) : (
            <ContextMenuLabel className="text-[0.65rem] font-extralight text-gray-400">
              Linked Audio ({clip.track_label}) • {clip.constituent_item_ids.length} channels
            </ContextMenuLabel>
          )}
        </ContextMenuContent>
      </div>
    </ContextMenu>
  );
});


function isPartiallyVisibleHorizontal(
  v: Virtualizer<any, any>,
  index: number
): boolean {
  const scrollEl = v.scrollElement;
  if (!scrollEl) return false;

  const items: VirtualItem[] = v.getVirtualItems();
  const item = items.find(i => i.index === index);
  if (!item) return false;

  const viewLeft = scrollEl.scrollLeft;
  const viewRight = viewLeft + scrollEl.clientWidth;

  const fullyLeft = item.end <= viewLeft;
  const fullyRight = item.start >= viewRight;

  const fullyInside =
    item.start >= viewLeft && item.end <= viewRight;

  return !fullyLeft && !fullyRight && !fullyInside;
}


interface FileSelectorProps {
  displayClips?: DisplayClip[];
  audioItems?: main.TimelineItem[] | null | undefined;
  linkedAudioGroups?: { [_ in string]?: main.LinkedAudioGroup | null } | null;
  currentFileId: string | null;
  onFileChange: (selectedItemId: string) => void;
  disabled?: boolean;
  className?: string;
  fps?: number;
}

const _ClipSelector: React.FC<FileSelectorProps> = ({
  displayClips: propDisplayClips,
  audioItems,
  linkedAudioGroups,
  currentFileId,
  onFileChange,
  fps,
  disabled,
  className,
}) => {
  const currentClipId = useClipStore((s) => s.currentClipId);

  const displayClips = useMemo(() => {
    if (propDisplayClips && propDisplayClips.length > 0) {
      return propDisplayClips;
    }
    return buildDisplayClips(audioItems, linkedAudioGroups);
  }, [propDisplayClips, audioItems, linkedAudioGroups]);

  const handleFileChange = useCallback((selectedItemId: string) => {
    onFileChange(selectedItemId);
  }, [onFileChange]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // ✨ Create a map to hold refs for each item's button
  const itemRefs = useRef(new Map<string, HTMLButtonElement | null>());

  if (displayClips.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center p-8 bg-zinc-800/50 border-2 border-dashed border-zinc-700 rounded-sm", className)}>
        <AudioFileIcon className="h-10 w-10 text-zinc-500 mb-3" />
        <h3 className="font-semibold text-lg text-zinc-300">No Audio Items</h3>
        <p className="text-sm text-zinc-500">The timeline does not contain any audio clips.</p>
      </div>
    );
  }
  const currUiScale = useUiStore(s => s.uiScale);
  const columnVirtualizer = useVirtualizer({
    count: displayClips.length,
    getScrollElement: () => scrollAreaRef.current?.querySelector('[data-slot="scroll-area-viewport"]') ?? null,
    estimateSize: () => 150 * currUiScale,
    horizontal: true,
    overscan: 10,
    isScrollingResetDelay: 200,
    useScrollendEvent: false,
    useAnimationFrameWithResizeObserver: true,
  });

  // Re-measure when uiScale or item count changes
  useLayoutEffect(() => {
    columnVirtualizer.measure?.();
  }, [currUiScale, displayClips.length]);

  useEffect(() => {
    if (!columnVirtualizer) return;
    if (!currentClipId) return;

    const selectedIndex = displayClips.findIndex(
      (clip) => clip.id === currentClipId || clip.constituent_item_ids?.includes(currentClipId)
    );
    if (selectedIndex === -1) return;

    const matchedClip = displayClips[selectedIndex];
    const viewport =
      scrollAreaRef.current?.querySelector<HTMLDivElement>(
        '[data-slot="scroll-area-viewport"]'
      );

    const buttonEl = itemRefs.current.get(matchedClip.id);

    if (!viewport || !buttonEl) return;

    const viewportRect = viewport.getBoundingClientRect();
    const buttonRect = buttonEl.getBoundingClientRect();

    const fullyVisible =
      buttonRect.left >= viewportRect.left &&
      buttonRect.right <= viewportRect.right;

    if (!fullyVisible) {
      columnVirtualizer.scrollToIndex(selectedIndex, {
        align: 'center',
        behavior: 'smooth',
      });
    }

  }, [currentClipId, displayClips, columnVirtualizer]);

  const virtualItems = columnVirtualizer.getVirtualItems();

  // scroll via mouse wheel
  useEffect(() => {
    const viewport =
      scrollAreaRef.current?.querySelector<HTMLDivElement>(
        '[data-slot="scroll-area-viewport"]'
      );

    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      e.preventDefault();

      viewport.scrollLeft += e.deltaY * 1.1;
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // middle mouse button click and drag
  useEffect(() => {
    const viewport =
      scrollAreaRef.current?.querySelector<HTMLDivElement>(
        '[data-slot="scroll-area-viewport"]'
      );

    if (!viewport) return;

    let isDragging = false;
    let startX = 0;
    let startScrollLeft = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return; // middle mouse button only

      e.preventDefault();

      isDragging = true;
      startX = e.clientX;
      startScrollLeft = viewport.scrollLeft;

      viewport.style.cursor = 'grabbing';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      viewport.scrollLeft = startScrollLeft - dx;
    };

    const onMouseUp = () => {
      if (!isDragging) return;

      isDragging = false;
      viewport.style.cursor = '';
    };

    viewport.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      viewport.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const allClipIds = useMemo(() => displayClips.map((clip) => clip.id), [displayClips]);

  return (
    <ScrollArea ref={scrollAreaRef} className={cn("w-full whitespace-nowrap pb-4 overflow-visible", className)}>
      <div
        className={cn(
          "relative h-28",
          "[@media(max-height:800px)]:h-26"
        )}
        style={{
          width: `${columnVirtualizer.getTotalSize()}px`,
        }}
      >
        {virtualItems.map((virtualItem) => {
          const clip = displayClips[virtualItem.index];
          if (!clip) return null;

          const isSelected =
            currentClipId === clip.id ||
            Boolean(clip.constituent_item_ids?.includes(currentClipId || ""));

          return (
            <div
              key={clip.id}
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
                forwardedRef={(el) => { itemRefs.current.set(clip.id, el); }}
                index={String(virtualItem.index + 1).padStart(String(displayClips.length).length, '0')}
                clip={clip}
                isSelected={isSelected}
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

const ClipSelector = React.memo(_ClipSelector);
export default ClipSelector