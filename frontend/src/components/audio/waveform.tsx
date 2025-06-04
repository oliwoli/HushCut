import { PauseIcon, PlayIcon, RedoDotIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback } from "react";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.esm.js"; // 1. Import Minimap
import ZoomPlugin from "wavesurfer.js/dist/plugins/zoom.esm.js";

import { main } from "@wails/go/models";
import { DetectionParams } from "@/types";

const formatAudioTime = (
  totalSeconds: number,
  frameRate: number,
  showHours: boolean = false
): string => {
  if (isNaN(totalSeconds) || totalSeconds < 0) {
    return showHours ? "00:00:00" : "00:00";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const frameNumber = Math.floor((totalSeconds % 1) * frameRate);
  const paddedFrameNumber = String(frameNumber).padStart(2, "0");
  const paddedSeconds = String(seconds).padStart(2, "0");
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (showHours || hours > 0) {
    const paddedHours = String(hours).padStart(2, "0");
    return `${paddedHours}:${paddedMinutes}:${paddedSeconds};${paddedFrameNumber}`;
  } else {
    return `${paddedMinutes}:${paddedSeconds};${paddedFrameNumber}`;
  }
};

interface SilencePeriod {
  start: number;
  end: number;
}

interface WaveformPlayerProps {
  audioUrl: string;
  peakData: main.PrecomputedWaveformData | null;
  clipOriginalStartSeconds: number;
  silenceData?: SilencePeriod[] | null;
  projectFrameRate?: number | 30.0;
  detectionParams: DetectionParams;
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  audioUrl,
  peakData,
  clipOriginalStartSeconds,
  silenceData,
  projectFrameRate,
  detectionParams,
}) => {
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const minimapContainerRef = useRef<HTMLDivElement>(null); // 2. Add a Ref for Minimap container
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<RegionsPlugin | null>(null);
  const addRegionsTimeoutRef = useRef<any | null>(null); // Ref to manage the timeout for adding regions

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const duration = peakData?.duration || 0;
  // const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const threshold = detectionParams.loudnessThreshold;
  const silenceDataRef = useRef(silenceData);
  useEffect(() => {
    silenceDataRef.current = silenceData;
  }, [silenceData]);
  const [debouncedSilenceData] = useDebounce(silenceData, 90);
  const [zoomTrigger, setZoomTrigger] = useState(0);
  const [debouncedZoomTrigger] = useDebounce(zoomTrigger, 150); // adjust delay as needed

  const [skipRegionsEnabled, setSkipRegionsEnabled] = useState(true);
  const skipRegionsEnabledRef = useRef(skipRegionsEnabled);
  useEffect(() => {
    skipRegionsEnabledRef.current = skipRegionsEnabled;
  }, [skipRegionsEnabled]);

  const clipOriginalStartSecondsRef = useRef(clipOriginalStartSeconds);
  useEffect(() => {
    clipOriginalStartSecondsRef.current = clipOriginalStartSeconds;
  }, [clipOriginalStartSeconds]);

  const segmentDurationRef = useRef(duration);
  useEffect(() => {
    segmentDurationRef.current = duration;
  }, [duration]);

  const silenceDataForSkippingRef = useRef(silenceData);
  useEffect(() => {
    silenceDataForSkippingRef.current = silenceData;
  }, [silenceData]);

  const currentProjectFrameRate = projectFrameRate || 30;

  const isPanningRef = useRef(false);
  const panStartXRef = useRef(0); // To store initial mouse X position
  const panInitialScrollLeftRef = useRef(0); // To store initial scrollLeft of the waveform
  const originalCursorRef = useRef(""); // To store the original cursor style

  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }
    if (addRegionsTimeoutRef.current) {
      clearTimeout(addRegionsTimeoutRef.current);
      addRegionsTimeoutRef.current = null;
    }

    if (!waveformContainerRef.current || !minimapContainerRef.current) {
      return;
    }
    if (
      !audioUrl ||
      !peakData ||
      !peakData.peaks ||
      peakData.peaks.length === 0 ||
      peakData.duration <= 0
    ) {
      if (audioUrl && (!audioUrl || !peakData))
        setIsLoading(true); // Keep loading if URL exists but data not ready
      else if (!audioUrl) setIsLoading(false); // No URL, not loading
      return;
    }

    console.log("WS Init: Initializing WaveSurfer with precomputed peaks.");
    setIsLoading(true);
    setCurrentTime(0);

    const wsRegions = RegionsPlugin.create();
    regionsPluginRef.current = wsRegions;

    const wsMinimap = Minimap.create({
      container: minimapContainerRef.current, // Target for the minimap
      waveColor: "#666666", // Lighter color for minimap waveform
      progressColor: "#666666", // Lighter progress color
      height: 40, // Desired height of the minimap
      dragToSeek: true, // Allows seeking by dragging on the minimap, true by default
      cursorWidth: 2,
      cursorColor: "#e64b3d",
      peaks: [peakData.peaks],
      duration: peakData.duration,
      normalize: false,
      barAlign: "bottom",
    });

    const wsOptions: WaveSurferOptions = {
      container: waveformContainerRef.current,
      dragToSeek: true,
      waveColor: "#777777",
      progressColor: "#777777", // This is the main waveform progress color, distinct from minimap
      cursorColor: "#e64b3d",
      cursorWidth: 2,
      height: "auto",
      width: "auto",
      fillParent: true,
      barAlign: "bottom",
      interact: true,
      url: audioUrl,
      peaks: [peakData.peaks],
      duration: peakData.duration,
      normalize: false,
      plugins: [wsRegions, wsMinimap], // 4. Add Minimap to plugins
      backend: "MediaElement",
      mediaControls: false,
      autoCenter: false,
      autoScroll: true,
      hideScrollbar: false, // Good to have when using minimap for navigation
      minPxPerSec: 15, // Optional: Adjust initial zoom of main waveform
    };

    try {
      const ws = WaveSurfer.create(wsOptions);
      ws.registerPlugin(
        ZoomPlugin.create({
          scale: 0.01,
          maxZoom: 180,
          exponentialZooming: true,
        })
      );

      wavesurferRef.current = ws;

      ws.on("ready", () => {
        setIsLoading(false);
        // Initial region drawing will be handled by the useEffect below
        // which depends on `isLoading` and other factors.
      });
      ws.on("play", () => setIsPlaying(true));
      ws.on("pause", () => setIsPlaying(false));
      ws.on("finish", () => {
        setIsPlaying(false);
        ws.setTime(0);
        setCurrentTime(0);
      }); // Reset to start on finish

      ws.on("interaction", (newTime: number) => {
        ws.setTime(newTime);
        setCurrentTime(newTime); // Keep updating React state for the current time display
      });

      ws.on("timeupdate", (time: number) => {
        //ws.setScroll(-1550);
        //ws.setScrollTime(time);

        setCurrentTime(time); // Keep updating React state for the current time display

        if (
          ws.isPlaying() &&
          skipRegionsEnabledRef.current &&
          silenceDataForSkippingRef.current?.length
        ) {
          for (const region of silenceDataForSkippingRef.current) {
            const epsilon = 0.01;
            const periodStartInSegment =
              region.start - clipOriginalStartSecondsRef.current;
            const periodEndInSegment =
              region.end - clipOriginalStartSecondsRef.current;

            // Filter out silences that are entirely outside the current segment's view
            // or become invalid after transformation.
            if (
              periodEndInSegment <= periodStartInSegment || // Zero or negative duration in segment context
              periodEndInSegment <= 0 || // Silence ends before or at the segment's start
              periodStartInSegment >= segmentDurationRef.current // Silence starts after or at the segment's end
            ) {
              continue; // This silence period is not relevant to the current segment's playback
            }

            if (periodStartInSegment > time) {
              break;
            }

            if (
              time >= periodStartInSegment &&
              time < periodEndInSegment - epsilon // `- epsilon` to ensure we don't skip if already at the very end
            ) {
              // Yes, we are inside a silence. Jump to its end (in segment time).
              // console.log(`Skipping: Time ${time.toFixed(2)} is in silence [${periodStartInSegment.toFixed(2)} - ${periodEndInSegment.toFixed(2)}]. Jumping to ${periodEndInSegment.toFixed(2)}`);
              ws.setTime(periodEndInSegment);
              break; // Exit loop for this timeupdate; WaveSurfer will emit a new timeupdate after seeking.
            }
          }
        }
      });

      ws.on("zoom", () => {
        setZoomTrigger((prev) => prev + 1); // trigger update
        //updateSilenceRegions(silenceDataRef.current);
      });

      ws.on("error", (err: Error | string) => {
        console.error("WaveSurfer error:", err);
        setIsLoading(false);
        setIsPlaying(false);
      });

      const scrollWrapper = ws.getWrapper(); // Get the scrollable wrapper element
      if (scrollWrapper) {
        // Store original cursor and set initial "grab" cursor
        originalCursorRef.current = scrollWrapper.style.cursor;
        //scrollWrapper.style.cursor = 'grab';

        const handleGlobalMouseMove = (event: MouseEvent) => {
          if (!isPanningRef.current || !wavesurferRef.current) return; // Check main ws ref too

          event.preventDefault(); // Prevent other actions during drag
          const wsInstance = wavesurferRef.current;
          const deltaX = event.clientX - panStartXRef.current;
          let newScrollLeft = panInitialScrollLeftRef.current - deltaX; // Subtract delta to move content with mouse

          // Optional: Clamp scroll position to prevent overscrolling
          // const maxScroll = scrollWrapper.scrollWidth - scrollWrapper.clientWidth;
          // newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScroll));

          wsInstance.setScroll(newScrollLeft);
        };

        const handleGlobalMouseUp = (event: MouseEvent) => {
          if (!isPanningRef.current) return;

          // Only truly act if it was a middle mouse drag, though isPanningRef should cover this
          isPanningRef.current = false;
          scrollWrapper.style.cursor = originalCursorRef.current;

          document.removeEventListener("mousemove", handleGlobalMouseMove);
          document.removeEventListener("mouseup", handleGlobalMouseUp);
        };

        const handleWaveformMouseDown = (event: MouseEvent) => {
          const wsInstance = wavesurferRef.current;
          if (!wsInstance) return;

          // Check for middle mouse button (event.button === 1)
          if (event.button === 1) {
            event.preventDefault(); // Prevent default middle-click actions (like autoscroll)
            event.stopPropagation(); // Prevent other listeners on WaveSurfer from acting on this

            isPanningRef.current = true;
            panStartXRef.current = event.clientX;
            panInitialScrollLeftRef.current = wsInstance.getScroll();

            scrollWrapper.style.cursor = "grabbing";

            // Add listeners to the document to capture mouse moves outside the wrapper
            document.addEventListener("mousemove", handleGlobalMouseMove);
            document.addEventListener("mouseup", handleGlobalMouseUp);
          }
        };

        scrollWrapper.addEventListener("mousedown", handleWaveformMouseDown);
      }
    } catch (error: any) {
      console.error(
        "Error during WaveSurfer create/load:",
        error.message || error
      );
      setIsLoading(false);
      setIsPlaying(false);
    }

    // --- Event listeners for the MINIMAP plugin instance ---
    if (wsMinimap) {
      const onMinimapDrag = (relativeX: number) => {
        const mainWs = wavesurferRef.current;
        if (!mainWs) return;
        const mainDuration = mainWs.getDuration(); // Use main wavesurfer's duration
        if (mainDuration > 0) {
          const newTime = relativeX * mainDuration;
          //console.log(`Minimap Drag event: newTime ${newTime.toFixed(3)} (relativeX: ${relativeX})`);
          setCurrentTime(newTime);
          mainWs.setTime(newTime);
          const pixelsPerSecond = mainWs.options.minPxPerSec;
          const timeToCenter = mainWs.getCurrentTime();
          const pixelPositionOfTimeToCenter = timeToCenter * pixelsPerSecond;
          const containerWidth = mainWs.getWidth();
          let targetScrollPx = pixelPositionOfTimeToCenter - containerWidth / 2;
          mainWs.setScroll(targetScrollPx);
        }
      };
      wsMinimap.on("drag", onMinimapDrag);

      const onMinimapClick = (relativeX: number, _relativeY: number) => {
        const mainWs = wavesurferRef.current;
        if (mainWs) {
          const mainDuration = mainWs.getDuration();
          if (mainDuration > 0) {
            const newTime = relativeX * mainDuration;
            // console.log(`Minimap Click event: newTime ${newTime.toFixed(3)}`);
            setCurrentTime(newTime);
            mainWs.setTime(newTime);
            const pixelsPerSecond = mainWs.options.minPxPerSec;
            const timeToCenter = mainWs.getCurrentTime();
            const pixelPositionOfTimeToCenter = timeToCenter * pixelsPerSecond;
            const containerWidth = mainWs.getWidth();
            let targetScrollPx =
              pixelPositionOfTimeToCenter - containerWidth / 2;
            mainWs.setScroll(targetScrollPx);
          }
        }
      };
      wsMinimap.on("click", onMinimapClick);
    }

    return () => {
      if (addRegionsTimeoutRef.current) {
        // Clear timeout on component unmount or effect re-run
        clearTimeout(addRegionsTimeoutRef.current);
        addRegionsTimeoutRef.current = null;
      }
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [audioUrl, peakData]); // Key dependencies for re-initializing WaveSurfer

  const updateSilenceRegions = useCallback(
    (sDataToProcess: SilencePeriod[] | null | undefined) => {
      const currentRegionsPlugin = regionsPluginRef.current;
      if (!currentRegionsPlugin) return;

      currentRegionsPlugin.clearRegions();
      const regionsContainerEl = (currentRegionsPlugin as any)
        .regionsContainer as HTMLElement | undefined;
      if (regionsContainerEl) {
        console.log("clearing regions");
        regionsContainerEl.innerHTML = "";
      }

      // Clear any existing timeout *before* setting a new one or returning.
      if (addRegionsTimeoutRef.current) {
        clearTimeout(addRegionsTimeoutRef.current);
        addRegionsTimeoutRef.current = null;
      }

      // Use `duration` (which is peakData.duration) for calculations.
      if (
        !sDataToProcess ||
        sDataToProcess.length === 0 ||
        duration <= 0 ||
        typeof clipOriginalStartSeconds !== "number"
      ) {
        return;
      }

      // Schedule new regions to be added.
      addRegionsTimeoutRef.current = setTimeout(() => {
        // Re-check plugin inside timeout, as it could be destroyed.
        if (!regionsPluginRef.current) return;

        sDataToProcess.forEach((period, index) => {
          const regionStartRelativeToWaveform =
            period.start - clipOriginalStartSeconds;
          const regionEndRelativeToWaveform =
            period.end - clipOriginalStartSeconds;

          if (
            regionEndRelativeToWaveform > 0 &&
            regionStartRelativeToWaveform < duration
          ) {
            const finalStart = Math.max(0, regionStartRelativeToWaveform);
            const finalEnd = Math.min(duration, regionEndRelativeToWaveform);

            // const relativeDuration = finalEnd - finalStart;

            // if (relativeDuration < detectionParams.minSilenceDurationSeconds)
            //   return;

            if (finalStart < finalEnd) {
              try {
                regionsPluginRef.current!.addRegion({
                  // Use ! if sure it's not null by now
                  id: `silence-marker_${index}_${period.start.toFixed(
                    2
                  )}-${period.end.toFixed(2)}`,
                  start: finalStart,
                  end: finalEnd,
                  color: "rgba(250, 7, 2, 0.15)",
                  drag: false,
                  resize: false,
                });
              } catch (e) {
                console.warn(`Failed to add region: ${(e as Error).message}`);
              }
            }
          }
        });
        addRegionsTimeoutRef.current = null;
      }, 30);
    },
    [clipOriginalStartSeconds, duration] // `regionsPluginRef` is stable, `duration` is from `peakData.duration`
  );

  const addMissingSilenceRegions = useCallback(
    (sDataToProcess: SilencePeriod[] | null | undefined) => {
      const plugin = regionsPluginRef.current;
      if (
        !plugin ||
        !sDataToProcess ||
        !duration ||
        clipOriginalStartSeconds == null
      )
        return;

      const existingRegionIds = new Set(plugin.getRegions().map((r) => r.id));

      sDataToProcess.forEach((period, index) => {
        const regionStartRelativeToWaveform =
          period.start - clipOriginalStartSeconds;
        const regionEndRelativeToWaveform =
          period.end - clipOriginalStartSeconds;

        if (
          regionEndRelativeToWaveform > 0 &&
          regionStartRelativeToWaveform < duration
        ) {
          const finalStart = Math.max(0, regionStartRelativeToWaveform);
          const finalEnd = Math.min(duration, regionEndRelativeToWaveform);

          if (finalStart < finalEnd) {
            const id = `silence-marker_${index}_${period.start.toFixed(
              2
            )}-${period.end.toFixed(2)}`;
            if (!existingRegionIds.has(id)) {
              try {
                plugin.addRegion({
                  id,
                  start: finalStart,
                  end: finalEnd,
                  color: "rgba(250, 7, 2, 0.15)",
                  drag: false,
                  resize: false,
                });
              } catch (e) {
                console.warn(`Failed to add region: ${(e as Error).message}`);
              }
            }
          }
        }
      });
    },
    [clipOriginalStartSeconds, duration]
  );

  useEffect(() => {
    if (
      !isLoading &&
      wavesurferRef.current &&
      regionsPluginRef.current &&
      duration > 0
    ) {
      updateSilenceRegions(debouncedSilenceData);
    }
  }, [debouncedSilenceData, isLoading, updateSilenceRegions, duration]);

  useEffect(() => {
    if (silenceDataRef.current) {
      updateSilenceRegions(silenceDataRef.current);
    }
  }, [debouncedZoomTrigger]);

  const handlePlayPause = useCallback(() => {
    if (wavesurferRef.current && !isLoading) wavesurferRef.current.playPause();
  }, [isLoading]);

  const toggleSkipRegions = useCallback(
    () => setSkipRegionsEnabled((prev) => !prev),
    []
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === " ") {
        event.preventDefault();
        handlePlayPause();
        return;
      }
      if (
        !wavesurferRef.current ||
        isLoading ||
        !duration ||
        isPlaying ||
        currentProjectFrameRate <= 0
      )
        return;
    },
    [isLoading, duration, isPlaying, currentProjectFrameRate, handlePlayPause]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const showHoursFormat = (duration || 0) >= 3600;
  const formattedCurrentTime = formatAudioTime(
    currentTime,
    currentProjectFrameRate,
    showHoursFormat
  );
  const formattedDuration = formatAudioTime(
    duration,
    currentProjectFrameRate,
    showHoursFormat
  );

  return (
    <div className="overflow-hidden mx-2">
      <div
        ref={waveformContainerRef}
        className="h-[260px] w-full mt-2 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-hidden relative"
      >
        <canvas className="absolute inset-0 z-0" />

        {/* Threshold overlay line */}
        <div
          className="absolute w-full h-[2px] rounded-full bg-teal-400 z-20 opacity-100 shadow-[0_0_10px_rgba(61,191,251,0.6)]"
          style={{ top: `${(Math.abs(threshold) / 60) * 100}%` }}
        />

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 text-white z-10">
            Loading waveform...
          </div>
        )}
      </div>

      <div
        ref={minimapContainerRef}
        className="h-[40px] w-full mt-1 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-hidden"
      ></div>

      <div className="w-full items-center flex justify-start py-2 gap-2 p-1">
        <button
          onClick={handlePlayPause}
          disabled={isLoading || !duration}
          className="text-gray-400 hover:text-amber-50"
        >
          {isPlaying ? (
            <PauseIcon size={34} className="p-1.5" />
          ) : (
            <PlayIcon size={34} className="p-1.5" />
          )}
        </button>
        {!isLoading && duration > 0 && (
          <button
            onClick={toggleSkipRegions}
            className={`p-1.5 rounded flex items-center text-xs ${
              skipRegionsEnabled
                ? "text-amber-500 hover:text-amber-400"
                : "text-stone-500 dark:hover:text-gray-400"
            }`}
            title={
              skipRegionsEnabled
                ? "Disable skipping silent regions"
                : "Enable skipping silent regions"
            }
          >
            <RedoDotIcon size={21} className="mr-1" />
            {/* Optional text: {skipRegionsEnabled ? "Skip ON" : "Skip OFF"} */}
          </button>
        )}
        {!isLoading && duration > 0 && (
          <span className="ml-2 text-xs gap-1.5 flex pt-1 text-gray-400/80 font-mono tracking-tighter mb-[3px]">
            <span>{formattedCurrentTime}</span> /{" "}
            <span>{formattedDuration}</span>
          </span>
        )}
      </div>
    </div>
  );
};

export default WaveformPlayer;
