// ./components/ui/fileSelector.tsx
import React, { useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { main } from "@wails/go/models";
import { GetWaveform } from "@wails/go/main/App";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

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

    pathData += `M ${x.toFixed(2)} ${y1.toFixed(2)} L ${x.toFixed(2)} ${y2.toFixed(2)} `;
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
const MIN_DB = -128; // Define a floor for silence
const MAX_DB = 0
const TARGET_PEAK_COUNT = 128;
const ASSUMED_SAMPLE_RATE = 48000; // A reasonable assumption for video-related audio
const MIN_SAMPLES_PER_PIXEL = 32; // Ensures very short clips still have some detail


const AudioClip = ({ item, isSelected, onClipClick, disabled, fps }: {
  item: main.TimelineItem,
  isSelected: boolean,
  onClipClick: () => void,
  disabled?: boolean,
  fps?: number
}) => {
  const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { startSeconds, endSeconds } = useMemo(() => {
    if (!fps || typeof item.source_start_frame !== 'number' || typeof item.source_end_frame !== 'number' || fps <= 0) {
      return { startSeconds: 0, endSeconds: 0 };
    }
    return {
      startSeconds: item.source_start_frame / fps,
      endSeconds: item.source_end_frame / fps,
    };
  }, [item.source_start_frame, item.source_end_frame, fps]);

  const clipDuration = endSeconds - startSeconds;

  useEffect(() => {
    let isCancelled = false;
    const fetchWaveform = async () => {
      if (!item.processed_file_name || clipDuration <= 0) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);

      const totalSamplesInClip = clipDuration * ASSUMED_SAMPLE_RATE;
      let dynamicSamplesPerPixel = Math.ceil(totalSamplesInClip / TARGET_PEAK_COUNT);
      dynamicSamplesPerPixel = Math.max(MIN_SAMPLES_PER_PIXEL, dynamicSamplesPerPixel);

      try {
        // MODIFICATION: Call the new generic GetWaveform function with 'linear' type.
        // minDb is irrelevant here, so we can pass 0 or a default.
        const peakData = await GetWaveform(
          item.processed_file_name + ".wav",
          dynamicSamplesPerPixel,
          "linear",
          -60.0, // Not used by the linear processor, but required by the function signature
          startSeconds,
          endSeconds
        );

        if (!isCancelled && peakData?.peaks) {
          // No more conversion needed! The data is already in the format we want.
          setWaveformPeaks(peakData.peaks);
        } else if (!isCancelled) {
          setWaveformPeaks(null);
        }
      } catch (error) {
        console.error(`Failed to fetch waveform for ${item.name}:`, error);
        if (!isCancelled) setWaveformPeaks(null);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    };

    fetchWaveform();
    return () => { isCancelled = true; };
  }, [item.id, item.processed_file_name, startSeconds, endSeconds, clipDuration]);

  return (
    <div className="flex flex-col flex-shrink-0 w-64">
      <div className="flex justify-between items-center text-xs text-zinc-500 font-mono px-1 pb-1">
        <span>{item.start_frame}</span>
        <span>Track {item.track_index}</span>
      </div>
      <button
        type="button"
        onClick={onClipClick}
        disabled={disabled}
        className={cn(
          "h-24 text-left rounded-md transition-all duration-150 ease-in-out overflow-hidden relative",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 focus-visible:ring-blue-400",
          "bg-teal-900/40 border",
          {
            "border-zinc-700 hover:border-zinc-600": !isSelected,
            "border-blue-500 ring-1 ring-blue-500": isSelected,
            "cursor-not-allowed opacity-60": disabled,
          }
        )}
      >
        <div className={cn("absolute inset-0 flex items-center justify-center text-teal-400/60 p-2 bottom-4", isLoading && "animate-pulse")}>
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
            <ClipLinkIcon className="text-zinc-400" />
            <p className="font-medium text-sm text-zinc-200 truncate">{item.name}</p>
          </div>
        </div>
      </button>
    </div>
  );
};

// MODIFICATION: Update props interface to include optional `fps`
interface FileSelectorProps {
  audioItems: main.TimelineItem[] | null | undefined;
  currentFileId: string | null;
  onFileChange: (selectedItemId: string) => void;
  disabled?: boolean;
  className?: string;
  fps?: number; // Added fps prop
}

const _FileSelector: React.FC<FileSelectorProps> = ({
  audioItems,
  currentFileId,
  onFileChange,
  disabled,
  className,
  fps, // Destructure fps
}) => {
  const sortedItems = useMemo(() => {
    if (!audioItems || audioItems.length === 0) return [];
    return [...audioItems].sort((a, b) => {
      if (a.track_index !== b.track_index) return a.track_index - b.track_index;
      if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
      return a.end_frame - b.end_frame;
    });
  }, [audioItems]);

  if (sortedItems.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center text-center p-8 bg-zinc-800/50 border-2 border-dashed border-zinc-700 rounded-lg", className)}>
        <AudioFileIcon className="h-10 w-10 text-zinc-500 mb-3" />
        <h3 className="font-semibold text-lg text-zinc-300">No Audio Items</h3>
        <p className="text-sm text-zinc-500">The timeline does not contain any audio clips.</p>
      </div>
    );
  }

  return (
    <ScrollArea className={cn("w-full whitespace-nowrap", className)}>
      <div className="flex w-max space-x-4 p-4">
        {sortedItems.map((item) => {
          const itemUniqueIdentifier = item.id || item.processed_file_name;
          if (!itemUniqueIdentifier) {
            console.warn("TimelineItem is missing a unique identifier:", item);
            return null;
          }
          return (
            <AudioClip
              key={itemUniqueIdentifier}
              item={item}
              isSelected={currentFileId === itemUniqueIdentifier}
              onClipClick={() => onFileChange(itemUniqueIdentifier)}
              disabled={disabled}
              fps={fps} // MODIFICATION: Pass fps down to the AudioClip
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
