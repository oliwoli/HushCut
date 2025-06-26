// ./components/ui/fileSelector.tsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import { cn, frameToTimecode } from "@/lib/utils";
import { main } from "@wails/go/models";
import { GetWaveform } from "@wails/go/main/App";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { EventsOn } from "@wails/runtime/runtime";
import { Progress } from "../ui/progress";
import { AlignJustifyIcon, AudioLinesIcon, LayersIcon } from "lucide-react";

// Icon for the empty state
const AudioFileIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("h-5 w-5", className)}>
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);
const SimulatedWaveform = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 200 50" preserveAspectRatio="none" className={cn("w-full h-full", className)}>
    <path d="M 0 25 L 10 15 L 20 35 L 30 10 L 40 40 L 50 20 L 60 30 L 70 15 L 80 35 L 90 5 L 100 45 L 110 25 L 120 10 L 130 40 L 140 20 L 150 30 L 160 15 L 170 35 L 180 10 L 190 40 L 200 25" stroke="currentColor" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
  </svg>
);

const generateWaveformJobKey = (fileName: string, start: number, end: number): string => {
  // Use toFixed() to prevent inconsistencies from floating point numbers
  return `${fileName}|${start.toFixed(3)}|${end.toFixed(3)}`;
};


const LinearWaveform = ({ peaks, className }: { peaks: number[], className?: string }) => {
  if (!peaks || peaks.length === 0) return null;

  const width = 200;
  const height = 50;
  const centerY = height / 2;

  // Since the backend now gives us pairs of [max, min], we can draw them.
  // If it only gives max, we can draw symmetrically. Let's assume symmetric for simplicity.
  const stepX = width / peaks.length;

  let pathData = '';
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i]; // A value from 0.0 to 1.0
    const x = i * stepX;

    // Draw a symmetric line from top to bottom around the center
    const y1 = centerY * (1 - peak); // Top of the line
    const y2 = centerY * (1 + peak); // Bottom of the line

    pathData += `M ${x.toFixed(2)} ${y1.toFixed(1)} L ${x.toFixed(2)} ${y2.toFixed(2)} `;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={className}>
      <path d={pathData} stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
};

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


const AudioClip = ({ item, index, isSelected, onClipClick, disabled, fps, conversionProgress: progress, waveformProgress, hasError }: {
  item: main.TimelineItem,
  index: string,
  isSelected: boolean,
  onClipClick: () => void,
  disabled?: boolean,
  fps?: number,
  conversionProgress?: number,
  waveformProgress?: number,
  hasError?: boolean,
}) => {
  if (!fps) return;
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);
  const isConverting = typeof progress === 'number' && progress >= 0 && progress < 100;
  const [isFetchingWaveform, setIsFetchingWaveform] = useState(true);
  const isLoading = isConverting || isFetchingWaveform;

  const isNested = !!item.type;

  const { startSeconds, endSeconds } = useMemo(() => {
    if (!fps || typeof item.source_start_frame !== 'number' || typeof item.source_end_frame !== 'number' || fps <= 0) {
      return { startSeconds: 0, endSeconds: 0 };
    }
    // For compounds, source start/end is relative to its own beginning.
    const start = isNested ? 0 : item.source_start_frame;
    const end = isNested ? (item.end_frame - item.start_frame) : item.source_end_frame;
    return {
      startSeconds: start / fps,
      endSeconds: end / fps,
    };
  }, [item, fps, isNested]);

  const clipDuration = endSeconds - startSeconds;

  useEffect(() => {
    let isCancelled = false;
    const delayMs = isSelected ? 5 : 15;

    const fetchWaveform = async () => {
      if (!item.processed_file_name || clipDuration <= 0) {
        setIsFetchingWaveform(false);
        return;
      }

      setIsFetchingWaveform(true);

      const totalSamplesInClip = clipDuration * ASSUMED_SAMPLE_RATE;
      let dynamicSamplesPerPixel = Math.ceil(totalSamplesInClip / TARGET_PEAK_COUNT);
      dynamicSamplesPerPixel = Math.max(MIN_SAMPLES_PER_PIXEL, dynamicSamplesPerPixel);

      try {
        await new Promise((res) => setTimeout(res, delayMs));

        if (isCancelled) return;

        const peakData = await GetWaveform(
          item.processed_file_name,
          dynamicSamplesPerPixel,
          "linear",
          -60.0,
          startSeconds,
          endSeconds
        );

        if (!isCancelled && peakData?.peaks) {
          setWaveformPeaks(peakData.peaks);
        } else if (!isCancelled) {
          setWaveformPeaks(null);
        }
      } catch (error) {
        console.error(`Failed to fetch waveform for ${item.name}:`, error);
        if (!isCancelled) setWaveformPeaks(null);
      } finally {
        if (!isCancelled) setIsFetchingWaveform(false);
      }
    };

    fetchWaveform();
    return () => { isCancelled = true; };
  }, [item.id, item.processed_file_name, startSeconds, endSeconds, clipDuration, isConverting]);


  return (
    <div className="flex flex-col flex-shrink-0 max-w-44 min-w-24">
      <div className="flex justify-between items-center text-xs text-zinc-500 font-mono pr-2 pb-1 space-x-2">
        <span className="text-stone-200 p-1 rounded-xs border-1 flex items-center">{index}</span>
        <span className="flex items-center gap-1">{frameToTimecode(item.start_frame, fps)}</span>
        <span className="flex items-center gap-0"><AlignJustifyIcon className="h-4 items-center text-gray-700" /> A{item.track_index}</span>
      </div>
      <button
        type="button"
        onClick={onClipClick}
        disabled={disabled}
        className={cn(
          "h-20 text-left rounded-sm transition-all duration-150 ease-in-out overflow-hidden relative",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 focus-visible:ring-blue-400",
          "bg-gray-700/40 border",
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

        <div className={cn("absolute inset-0 flex items-center justify-center text-teal-400/60 p-1 bottom-6", isLoading && "animate-pulse")}>
          {isLoading ? <SimulatedWaveform /> : (
            waveformPeaks ?
              <LinearWaveform
                peaks={waveformPeaks}
              /> :
              <SimulatedWaveform />
          )}
        </div>
        <div className="relative z-10 h-full flex flex-col justify-end p-2 bg-gradient-to-t from-black/50 via-black/20 to-transparent">
          <div className="flex items-center space-x-1.5">
            {isNested && (
              <LayersIcon className="text-sm h-[14px] text-stone-400 p-0 mr-1" />
            )}
            {!isNested && (
              <AudioLinesIcon className="text-sm h-[14px] text-stone-400 p-0 mr-1" />
            )}
            {/* <ClipLinkIcon className="text-zinc-400" /> */}
            <p className="font-medium text-xs text-zinc-200/90 truncate">{item.name}</p>
          </div>
        </div>
      </button>
    </div>
  );
};

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
  //const projectData = useGlobalStore(s => s.projectData);
  //const audioItems = projectData?.timeline?.audio_track_items || [];
  //const fps = projectData?.timeline?.fps || 30;

  const sortedItems = useMemo(() => {
    if (!audioItems || audioItems.length === 0) return [];
    // QUICK FIX: Filter out compound clips as they are not yet supported and break the UI.
    return [...audioItems]
      // .filter(item => item.type !== 'Compound')
      .sort((a, b) => {
        if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
        if (a.track_index !== b.track_index) return a.track_index - b.track_index;
        return a.end_frame - b.end_frame;
      });
  }, [audioItems]);

  if (sortedItems.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center p-8 bg-zinc-800/50 border-2 border-dashed border-zinc-700 rounded-sm", className)}>
        <AudioFileIcon className="h-10 w-10 text-zinc-500 mb-3" />
        <h3 className="font-semibold text-lg text-zinc-300">No Audio Items</h3>
        <p className="text-sm text-zinc-500">The timeline does not contain any audio clips.</p>
      </div>
    );
  }
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [conversionProgress, setConversionProgress] = useState<Record<string, number>>({});
  const [waveformProgress, setWaveformProgress] = useState<Record<string, number>>({});


  useEffect(() => {
    const getFileName = (fullPath: string): string => {
      if (!fullPath) return '';
      return fullPath.split(/[\\/]/).pop() || '';
    }

    const unsubProgress = EventsOn('conversion:progress', (e: { filePath: string; percentage: number }) => {
      const fileName = getFileName(e.filePath);
      if (fileName) {
        setConversionProgress(prev => ({ ...prev, [fileName]: e.percentage }));
        console.log(`${fileName}: ${e.percentage}`)
      }
    });

    const unsubDone = EventsOn('conversion:done', (e: { filePath: string }) => {
      const fileName = getFileName(e.filePath);
      if (fileName) {
        // Set to 100 to show completion, then clear after a short delay
        setConversionProgress(prev => ({ ...prev, [fileName]: 100 }));
        setTimeout(() => {
          setConversionProgress(prev => {
            const { [fileName]: _, ...rest } = prev;
            return rest;
          });
        }, 500);
      }
    });

    const unsubError = EventsOn('conversion:error', (e: { filePath: string }) => {
      const fileName = getFileName(e.filePath);
      if (fileName) {
        // Use a negative number to signify an error state
        setConversionProgress(prev => ({ ...prev, [fileName]: -1 }));
      }
    });

    const unsubWaveformProgress = EventsOn('waveform:progress', (e: { filePath: string; clipStart: number; clipEnd: number; percentage: number }) => {
      const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
      setWaveformProgress(prev => ({ ...prev, [jobKey]: e.percentage }));
    });
    const unsubWaveformDone = EventsOn('waveform:done', (e: { filePath: string; clipStart: number; clipEnd: number; }) => {
      const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
      setWaveformProgress(prev => {
        const { [jobKey]: _, ...rest } = prev;
        return rest;
      });
    });


    return () => {
      unsubProgress();
      unsubDone();
      unsubError();
      unsubWaveformProgress();
      unsubWaveformDone();
    };
  }, []);

  useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element) return;

    const handleWheel = (e: globalThis.WheelEvent) => {
      // Find the scrollable viewport inside the component
      const viewport = element.querySelector<HTMLDivElement>(':scope > [data-radix-scroll-area-viewport]');
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

    // Return a cleanup function to remove the listener when the component unmounts
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, []); // The empty dependency array ensures this effect runs only once

  const totalItems = sortedItems.length;
  const digits = String(totalItems).length;

  return (
    <ScrollArea ref={scrollAreaRef} className={cn("w-full whitespace-nowrap pb-4 overflow-visible", className)}>
      <div className="flex w-max space-x-1 px-4">
        {sortedItems.map((item, index) => {
          const itemUniqueIdentifier = item.id || item.processed_file_name;
          if (!itemUniqueIdentifier) {
            console.warn("TimelineItem is missing a unique identifier:", item);
            return null;
          }
          const convProgress = item.processed_file_name ? conversionProgress[item.processed_file_name] : undefined;


          const start = (item.type === 'Compound' ? 0 : item.source_start_frame) / (fps || 30);
          const end = (item.type === 'Compound' ? (item.end_frame - item.start_frame) : item.source_end_frame) / (fps || 30);
          const jobKey = item.processed_file_name ? generateWaveformJobKey(item.processed_file_name, start, end) : '';
          const waveProgress = waveformProgress[jobKey];
          const paddedIndex = String(index + 1).padStart(digits, '0');

          return (
            <AudioClip
              key={itemUniqueIdentifier}
              index={paddedIndex}
              item={item}
              isSelected={currentFileId === itemUniqueIdentifier}
              onClipClick={() => onFileChange(itemUniqueIdentifier)}
              disabled={disabled}
              fps={fps}
              conversionProgress={convProgress}
              waveformProgress={waveProgress}
              hasError={convProgress === -1}
            />
          );
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};

const FileSelector = React.memo(_FileSelector);
export default FileSelector
