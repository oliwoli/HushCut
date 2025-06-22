import { LoaderCircleIcon, PauseIcon, PlayIcon, RedoDotIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.esm.js"; // 1. Import Minimap
import ZoomPlugin from "wavesurfer.js/dist/plugins/zoom.esm.js";

import { useClipParameter } from "@/stores/clipStore";

import { useClipStore } from "@/stores/clipStore";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { ActiveClip, DetectionParams } from "@/types";
import { useSilenceData } from "@/hooks/useSilenceData";
import { useWaveformData } from "@/hooks/useWaveformData";

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
  activeClip: ActiveClip | null;
  projectFrameRate?: number | 30.0;
  httpPort: number
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  activeClip,
  projectFrameRate,
  httpPort
}) => {

  if (!activeClip || !projectFrameRate || !httpPort) {
    // You can return a placeholder here if you want, e.g., <div>Select a clip</div>
    return null;
  }

  const clipId = activeClip?.id ?? '';

  const detectionParams: DetectionParams | null = useStoreWithEqualityFn(
    useClipStore,
    (s) => { // `s` is the clipStore state
      if (!clipId) return null;

      const correctParams = s.parameters[clipId] ?? s.liveDefaultParameters;

      return {
        loudnessThreshold: correctParams.threshold,
        minSilenceDurationSeconds: correctParams.minDuration,
        minContentDuration: correctParams.minContent,
        paddingLeftSeconds: correctParams.paddingLeft,
        paddingRightSeconds: correctParams.paddingRight,
      };
    },
    shallow
  );

  const {
    peakData,
    cutAudioSegmentUrl
  } = useWaveformData(activeClip, projectFrameRate, httpPort);


  const {
    silenceData
  } = useSilenceData(activeClip, detectionParams, projectFrameRate || null);

  const clipOriginalStartSeconds = activeClip.sourceStartFrame / projectFrameRate
  const clipOriginalStartSecondsRef = useRef(clipOriginalStartSeconds);
  useEffect(() => {

    clipOriginalStartSecondsRef.current = clipOriginalStartSeconds;
  }, [clipOriginalStartSeconds]);


  const audioUrl = activeClip?.previewUrl
  const [threshold] = useClipParameter("threshold");

  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const minimapContainerRef = useRef<HTMLDivElement>(null); // 2. Add a Ref for Minimap container
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<RegionsPlugin | null>(null);
  const addRegionsTimeoutRef = useRef<any | null>(null); // Ref to manage the timeout for adding regions

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  //const isLoading = isWaveformLoading || isSilenceLoading;
  const duration = peakData?.duration || 0;
  // const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const silenceDataRef = useRef(silenceData);
  useEffect(() => {
    silenceDataRef.current = silenceData;
  }, [silenceData]);
  const [zoomTrigger, setZoomTrigger] = useState(0);
  const [debouncedZoomTrigger] = useDebounce(zoomTrigger, 150); // adjust delay as needed

  const [skipRegionsEnabled, setSkipRegionsEnabled] = useState(true);
  const skipRegionsEnabledRef = useRef(skipRegionsEnabled);
  useEffect(() => {
    skipRegionsEnabledRef.current = skipRegionsEnabled;
  }, [skipRegionsEnabled]);

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
      container: minimapContainerRef.current,
      waveColor: "#666666",
      progressColor: "#666666",
      height: 40,
      dragToSeek: true,
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
      progressColor: "#777777",
      cursorColor: "#e64b3d",
      cursorWidth: 2,
      height: "auto",
      width: "auto",
      fillParent: true,
      barAlign: "bottom",
      interact: true,
      url: cutAudioSegmentUrl || audioUrl,
      peaks: [peakData.peaks],
      duration: peakData.duration,
      normalize: false,
      plugins: [wsRegions, wsMinimap],
      backend: "MediaElement",
      mediaControls: false,
      autoCenter: false,
      autoScroll: true,
      hideScrollbar: false,
      minPxPerSec: 15,
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
      ws.on("play", () => {
        setIsPlaying(true);
        // make sure the volume is set to 1
        if (ws.getVolume() != 1) {
          console.log("Volume was not 1, setting it to 1 webkit is cursed.");
          // let's make an alert while we're at it to warnt the user of cursed webkit
          alert("Volume was not 1, setting it to 1 webkit is cursed.");
          // TODO: remove when building for production
          ws.setVolume(1);
        }
      });
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
            if (
              periodEndInSegment <= periodStartInSegment ||
              periodEndInSegment <= 0 ||
              periodStartInSegment >= segmentDurationRef.current
            ) {
              continue;
            }

            if (periodStartInSegment > time) {
              break;
            }

            if (
              time >= periodStartInSegment &&
              time < periodEndInSegment - epsilon
            ) {
              ws.setTime(periodEndInSegment);
              break;
            }
          }
        }
      });

      ws.on("zoom", () => {
        setZoomTrigger((prev) => prev + 1);
      });

      ws.on("error", (err: Error | string) => {
        console.error("WaveSurfer error:", err);
        setIsLoading(false);
        setIsPlaying(false);
      });

      const scrollWrapper = ws.getWrapper();
      if (scrollWrapper) {
        originalCursorRef.current = scrollWrapper.style.cursor;
        const handleGlobalMouseMove = (event: MouseEvent) => {
          if (!isPanningRef.current || !wavesurferRef.current) return;

          event.preventDefault();
          const wsInstance = wavesurferRef.current;
          const deltaX = event.clientX - panStartXRef.current;
          let newScrollLeft = panInitialScrollLeftRef.current - deltaX;
          wsInstance.setScroll(newScrollLeft);
        };

        const handleGlobalMouseUp = (event: MouseEvent) => {
          if (!isPanningRef.current) return;

          isPanningRef.current = false;
          scrollWrapper.style.cursor = originalCursorRef.current;

          document.removeEventListener("mousemove", handleGlobalMouseMove);
          document.removeEventListener("mouseup", handleGlobalMouseUp);
        };

        const handleWaveformMouseDown = (event: MouseEvent) => {
          const wsInstance = wavesurferRef.current;
          if (!wsInstance) return;

          // middle mouse button
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();

            isPanningRef.current = true;
            panStartXRef.current = event.clientX;
            panInitialScrollLeftRef.current = wsInstance.getScroll();

            scrollWrapper.style.cursor = "grabbing";

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
        const mainDuration = mainWs.getDuration();
        if (mainDuration > 0) {
          const newTime = relativeX * mainDuration;
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
        clearTimeout(addRegionsTimeoutRef.current);
        addRegionsTimeoutRef.current = null;
      }
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [audioUrl, peakData]);

  const updateSilenceRegions = useCallback(
    (sDataToProcess: SilencePeriod[] | null | undefined) => {
      const currentRegionsPlugin = regionsPluginRef.current;
      if (!currentRegionsPlugin) return;
      currentRegionsPlugin.clearRegions();
      const regionsContainerEl = (currentRegionsPlugin as any)
        .regionsContainer as HTMLElement | undefined;
      if (regionsContainerEl) {
        regionsContainerEl.innerHTML = "";
      }

      if (addRegionsTimeoutRef.current) {
        clearTimeout(addRegionsTimeoutRef.current);
        addRegionsTimeoutRef.current = null;
      }

      if (
        !sDataToProcess ||
        sDataToProcess.length === 0 ||
        duration <= 0
      ) {
        return;
      }
      addRegionsTimeoutRef.current = setTimeout(() => {
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

            if (finalStart < finalEnd) {
              try {
                regionsPluginRef.current!.addRegion({
                  id: `silence-marker_${index}_${period.start}-${period.end}`,
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
      }, 0);
    },
    [clipOriginalStartSeconds, duration]
  );

  useEffect(() => {
    if (
      !isLoading &&
      wavesurferRef.current &&
      regionsPluginRef.current &&
      activeClip &&
      duration > 0
    ) {
      updateSilenceRegions(silenceData);
    }
  }, [silenceData, isLoading, updateSilenceRegions, duration, activeClip]);

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

  const skipClass = useMemo(() => {
    return skipRegionsEnabled
      ? "text-amber-500 hover:text-amber-400"
      : "text-stone-500 dark:hover:text-gray-400";
  }, [skipRegionsEnabled]);

  const skipTitle = useMemo(() => {
    return skipRegionsEnabled
      ? "Disable skipping silent regions"
      : "Enable skipping silent regions";
  }, [skipRegionsEnabled]);

  const SkipButton = useMemo(() => {
    return memo(function SkipButton() {
      return (
        <button
          onClick={toggleSkipRegions}
          className={`p-1.5 rounded flex items-center text-xs ${skipClass}`}
          title={skipTitle}
        >
          <RedoDotIcon size={21} className="mr-1" />
          {/* Optional text: {skipRegionsEnabled ? "Skip ON" : "Skip OFF"} */}
        </button>
      );
    });
  }, [toggleSkipRegions, skipClass, skipTitle]);

  return (
    <>
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
          <div className="absolute inset-0 flex items-end justify-end p-5 bg-gray-800/20 bg-opacity-50 text-white/60 z-10">
            <LoaderCircleIcon className="text-gray-500/40 animate-spin" />
          </div>
        )}
      </div>

      <div className="shadow-xl shadow-stone-900 rounded-md border-1 mt-1 overflow-hidden">
        <div
          ref={minimapContainerRef}
          className="h-[40px] w-full bg-[#2c2d32] border-0 border-t-0 border-stone-900 rounded-none box-border overflow-hidden shadow-inner shadow-stone-900/50"
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
            <SkipButton />
          )}
          {!isLoading && duration > 0 && (
            <span className="ml-2 text-xs gap-1.5 flex pt-1 text-gray-400/80 font-mono tracking-tighter mb-[3px]">
              <span>{formattedCurrentTime}</span> /{" "}
              <span>{formattedDuration}</span>
            </span>
          )}
        </div>
      </div>
    </>
  );
};

export default WaveformPlayer;
