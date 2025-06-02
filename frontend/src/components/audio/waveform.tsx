import { PauseIcon, PlayIcon, RedoDotIcon } from "lucide-react"; // Removed SkipForwardIcon as it wasn't used
import React, { useRef, useEffect, useState, useCallback } from "react";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.esm.js"; // 1. Import Minimap
import ZoomPlugin from 'wavesurfer.js/dist/plugins/zoom.esm.js'

import { GetLogarithmicWaveform } from "@wails/go/main/App";
import { main } from "@wails/go/models";

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
    silenceData?: SilencePeriod[] | null;
    projectFrameRate?: number | 30.0;
    threshold: number
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
    audioUrl,
    silenceData,
    projectFrameRate,
    threshold
}) => {
    const waveformContainerRef = useRef<HTMLDivElement>(null);
    const minimapContainerRef = useRef<HTMLDivElement>(null); // 2. Add a Ref for Minimap container
    const wavesurferRef = useRef<WaveSurfer | null>(null);
    const regionsPluginRef = useRef<RegionsPlugin | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);

    const silenceDataRef = useRef(silenceData);
    useEffect(() => {
        silenceDataRef.current = silenceData;
    }, [silenceData]);
    const [debouncedSilenceData] = useDebounce(silenceData, 90);

    const [precomputedData, setPrecomputedData] =
        useState<main.PrecomputedWaveformData | null>(null);
    const [skipRegionsEnabled, setSkipRegionsEnabled] = useState(true);
    const skipRegionsEnabledRef = useRef(skipRegionsEnabled);
    useEffect(() => {
        skipRegionsEnabledRef.current = skipRegionsEnabled;
    }, [skipRegionsEnabled]);
    const silenceDataForSkippingRef = useRef(silenceData);
    useEffect(() => {
        silenceDataForSkippingRef.current = silenceData;
    }, [silenceData]);

    const currentProjectFrameRate = projectFrameRate || 30.0;

    const isPanningRef = useRef(false);
    const panStartXRef = useRef(0); // To store initial mouse X position
    const panInitialScrollLeftRef = useRef(0); // To store initial scrollLeft of the waveform
    const originalCursorRef = useRef(''); // To store the original cursor style 

    const [wsCursorX, setWsCursorX] = useState(0)

    useEffect(() => {
        if (!audioUrl) {
            setPrecomputedData(null);
            setDuration(0);
            setIsLoading(false);
            return;
        }
        let isCancelled = false;
        const fetchPrecomputedData = async () => {
            console.log("Fetching precomputed data for:", audioUrl);
            setIsLoading(true);
            try {
                const data = await GetLogarithmicWaveform(audioUrl, 256, -60.0);
                if (isCancelled) return;
                if (
                    !data ||
                    !data.peaks ||
                    data.peaks.length === 0 ||
                    data.duration <= 0
                ) {
                    throw new Error("Invalid precomputed waveform data.");
                }
                setPrecomputedData(data);
                setDuration(data.duration);
            } catch (error) {
                if (isCancelled) return;
                console.error("Error fetching precomputed waveform data:", error);
                setPrecomputedData(null);
                setDuration(0);
                setIsLoading(false); // Error during fetch, ensure loading is false
            }
        };
        fetchPrecomputedData();
        return () => {
            isCancelled = true;
        };
    }, [audioUrl]);

    useEffect(() => {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
      if (!waveformContainerRef.current || !minimapContainerRef.current) {
        return;
      }
      if (
        !audioUrl ||
        !precomputedData ||
        !precomputedData.peaks ||
        precomputedData.peaks.length === 0 ||
        precomputedData.duration <= 0
      ) {
        if (audioUrl && (!audioUrl || !precomputedData))
          setIsLoading(true); // Keep loading if URL exists but data not ready
        else if (!audioUrl) setIsLoading(false); // No URL, not loading
        return;
      }

      console.log("WS Init: Initializing WaveSurfer with precomputed peaks.");
      setIsLoading(true);
      setCurrentTime(0);

      const wsRegions = RegionsPlugin.create();
      regionsPluginRef.current = wsRegions;

      // 3. Initialize Minimap Plugin
      const wsMinimap = Minimap.create({
        container: minimapContainerRef.current, // Target for the minimap
        waveColor: "#666666", // Lighter color for minimap waveform
        progressColor: "#666666", // Lighter progress color
        height: 40, // Desired height of the minimap
        dragToSeek: true, // Allows seeking by dragging on the minimap, true by default
        cursorWidth: 2,
        cursorColor: "#e64b3d",
        peaks: [precomputedData.peaks],
        duration: precomputedData.duration,
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
        peaks: [precomputedData.peaks],
        duration: precomputedData.duration,
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
            // the amount of zoom per wheel step, e.g. 0.5 means a 50% magnification per scroll
            scale: 0.01,
            // Optionally, specify the maximum pixels-per-second factor while zooming
            maxZoom: 180,
            exponentialZooming: true,
          })
        );

        wavesurferRef.current = ws;

        ws.on("ready", () => {
          console.log("WaveSurfer: 'ready'.");
          setIsLoading(false);
          const internalDuration = ws.getDuration();
          if (
            Math.abs(internalDuration - (precomputedData?.duration || 0)) > 0.01
          ) {
            setDuration(internalDuration);
          }
          if (regionsPluginRef.current && silenceDataRef.current) {
            updateSilenceRegions(
              regionsPluginRef.current,
              silenceDataRef.current
            );
          }
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
              const epsilon = 0.01; // A small buffer to avoid floating point issues or skipping too late

              if (region.start > time) {
                // all other regions are going to come after this one, we can break
                break;
              }

              if (
                region.end > region.start &&
                time >= region.start &&
                time < region.end - epsilon
              ) {
                ws.setTime(region.end);
                break;
              }
            }
          }
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
            let targetScrollPx =
              pixelPositionOfTimeToCenter - containerWidth / 2;
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
              const pixelPositionOfTimeToCenter =
                timeToCenter * pixelsPerSecond;
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
        if (wavesurferRef.current) {
          console.log("WaveSurfer cleanup: Destroying instance.");
          wavesurferRef.current.destroy(); // This also destroys registered plugins like minimap
          wavesurferRef.current = null;
        }
      };

      // Dependencies: audioUrl (for new file), precomputedData (when it's fetched/updated), audioUrl (when it's ready)
      // minimapContainerRef.current is not a reactive dependency in the same way, its existence is checked.
    }, [audioUrl, precomputedData]);

    const updateSilenceRegions = useCallback(
      (
        regionsPlugin: RegionsPlugin | null,
        sData: SilencePeriod[] | null | undefined
      ) => {
        if (!regionsPlugin) return;
        regionsPlugin.clearRegions();
        const regionsContainerEl = (regionsPlugin as any).regionsContainer as
          | HTMLElement
          | undefined;
        if (regionsContainerEl) regionsContainerEl.innerHTML = ""; // Ensure visual cleanup

        // Debounce adding regions slightly to allow DOM to clear if there were issues
        const timeoutId = setTimeout(() => {
          if (regionsPlugin && sData && sData.length > 0) {
            sData.forEach((period, index) => {
              try {
                regionsPlugin.addRegion({
                  id: `silence-marker_${index}_${period.start.toFixed(
                    2
                  )}-${period.end.toFixed(2)}`,
                  start: period.start,
                  end: period.end,
                  color: "rgba(250, 7, 2, 0.15)",
                  drag: false,
                  resize: false,
                });
              } catch (e) {
                console.warn(
                  `Failed to add region: ${(e as Error).message}`,
                  period
                );
              }
            });
          }
        }, 30); // Small delay
        return () => clearTimeout(timeoutId); // Cleanup timeout
      },
      []
    );

    useEffect(() => {
        if (!isLoading && wavesurferRef.current && regionsPluginRef.current) {
            updateSilenceRegions(regionsPluginRef.current, debouncedSilenceData);
        }
    }, [debouncedSilenceData, isLoading, updateSilenceRegions]);

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
                className="h-[260px] w-full mt-2 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-visible relative"
            >
                <canvas className="absolute inset-0 z-0" />

                {/* Threshold overlay line */}
                <div
                    className="absolute w-full h-[2px] rounded-full bg-teal-400 z-20 opacity-100 shadow-[0_0_10px_rgba(61,191,251,0.6)]"
                    style={{ top: `${(Math.abs(threshold) / 60) * 100}%` }}
                />

                {/* <div
                    className="absolute top-0 w-[2px] h-full bg-white z-[30] pointer-events-none"
                    style={{ left: `${currentTime * (wavesurferRef.current?.options.minPxPerSec || 0)}px` }} // update dynamically
                /> */}

                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 text-white z-10">
                        Loading waveform...
                    </div>
                )}
            </div>

            <div
                ref={minimapContainerRef}
                className="h-[40px] w-full mt-1 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-hidden"
            >
            </div>

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
                        className={`p-1.5 rounded flex items-center text-xs ${skipRegionsEnabled
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
                    <span className="ml-2 text-sm gap-1.5 flex pt-1 text-gray-400">
                        <span>{formattedCurrentTime}</span> /{" "}
                        <span>{formattedDuration}</span>
                    </span>
                )}
            </div>
        </div>
    );
};

export default WaveformPlayer;
