import { AudioWaveformIcon, LoaderCircleIcon, PauseIcon, PlayIcon, RedoDotIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.esm.js";

import { useClipParameter, useGlobalStore, useTimecodeStore } from "@/stores/clipStore";

import { ActiveClip } from "@/types";
import { useSilenceData } from "@/hooks/useSilenceData";
import { useWaveformData } from "@/hooks/useWaveformData";
//import { frameToTimecode, secToFrames } from "@/lib/utils";

import Timecode, { FRAMERATE } from "smpte-timecode";

import { SetDavinciPlayhead } from "@wails/go/main/App";
import { secToFrames, formatDuration } from "@/lib/utils";
import { useResizeObserver } from "@/hooks/hooks";
import { ZoomSlider } from "@/components/ui/zoomSlider";

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

const getFrameFromTime = (time: number, frameRate: number): number => {
  if (!time || !frameRate) return 0;
  return Math.floor((time % 1) * frameRate);
};

interface SilencePeriod {
  start: number;
  end: number;
}

interface TimecodeDisplayProps {
  time: number;
  duration: number;
  frameRate: number;
}

export const TimecodeDisplay: React.FC<TimecodeDisplayProps> = React.memo(({
  time,
  duration,
  frameRate,
}) => {
  // Determine if the hour format is needed based on the total duration
  const showHours = duration >= 3600;

  // Format the current time and total duration
  const formattedTime = formatAudioTime(time, frameRate, showHours);
  const formattedDuration = formatAudioTime(duration, frameRate, showHours);

  return (
    <span className="ml-2 flex gap-1.5 pt-1 text-xs font-mono tracking-tighter text-gray-400/80 mb-[3px]">
      <span>{formattedTime}</span>
      <span>/</span>
      <span>{formattedDuration}</span>
    </span>
  );
});

TimecodeDisplay.displayName = "TimecodeDisplay";


interface WaveformPlayerProps {
  activeClip: ActiveClip | null;
  projectFrameRate?: number | 30.0;
  httpPort: number;
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  activeClip,
  projectFrameRate,
  httpPort,
}) => {
  if (!activeClip || !projectFrameRate || !httpPort) {
    // You can return a placeholder here if you want, e.g., <div>Select a clip</div>
    return null;
  }

  const { peakData, cutAudioSegmentUrl } = useWaveformData(
    activeClip,
    projectFrameRate,
    httpPort
  );

  const { silenceData } = useSilenceData(activeClip, projectFrameRate || null);
  const totalSilenceDuration = useMemo(() => {
    if (!silenceData) return 0;
    return silenceData.reduce((acc, curr) => acc + (curr.end - curr.start), 0);
  }, [silenceData]);

  const clipOriginalStartSeconds =
    activeClip.sourceStartFrame / projectFrameRate;
  const clipOriginalStartSecondsRef = useRef(clipOriginalStartSeconds);
  useEffect(() => {
    clipOriginalStartSecondsRef.current = clipOriginalStartSeconds;
  }, [clipOriginalStartSeconds]);

  const audioUrl = activeClip?.previewUrl;
  const [threshold] = useClipParameter("threshold");
  const isThresholdDragging = useGlobalStore(s => s.isThresholdDragging);

  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const minimapContainerRef = useRef<HTMLDivElement>(null); // 2. Add a Ref for Minimap container
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<RegionsPlugin | null>(null);
  const addRegionsTimeoutRef = useRef<any | null>(null); // Ref to manage the timeout for adding regions

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const duration = peakData?.duration || 0;

  const currTimecode = useTimecodeStore((s) => s.timecode);
  const setTimecode = useTimecodeStore((s) => s.setTimecode);
  const clipFrameDuration =
    activeClip.sourceEndFrame - activeClip.sourceStartFrame;
  const maxTimecode = Timecode(
    activeClip.startFrame + clipFrameDuration,
    projectFrameRate as FRAMERATE,
    false
  );

  //update the player time if timecode fits
  useEffect(() => {
    if (!wavesurferRef.current || !currTimecode) return;
    if (currTimecode.frameCount < maxTimecode.frameCount) {
      console.log("curr timecode: ", currTimecode);
      //const currTime = (currTimelineFrameRefTC.frameCount - activeClip.startFrame) / projectFrameRate;
      const clipTime =
        (currTimecode.frameCount - activeClip.startFrame) / projectFrameRate;
      console.log("we can use the timecode! ", clipTime);
      currentTimeRef.current = clipTime;
      setDisplayedTime(clipTime);
      wavesurferRef.current?.setTime(clipTime);
    }
  }, [currTimecode]);

  const currentTimeRef = useRef(0);
  const [displayedTime, setDisplayedTime] = useState(0);

  // Reset current time when activeClip changes
  useEffect(() => {
    currentTimeRef.current = 0;
    setDisplayedTime(0);
  }, [activeClip]);

  const currTimelineFrameRef = useRef<number | null>(null);
  const lastRenderedFrameRef = useRef(-1);


  const lastTimecodeRef = useRef<string | null>(null);
  const lastCallTimeRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const isUpdatingRef = useRef(false);
  const cooldown = 125; // ms

  // 1) Update the “current frame” ref in real time (always, even during playback)
  useEffect(() => {
    if (isLoading || displayedTime == null) return;
    const frame =
      secToFrames(displayedTime, projectFrameRate) + activeClip.startFrame;
    currTimelineFrameRef.current = frame;
  }, [displayedTime, isLoading, projectFrameRate, activeClip.startFrame]);

  // 2) Cooldown-style throttle, but only when paused
  useEffect(() => {
    if (isPlaying || isLoading || displayedTime == null) {
      // If we're playing, loading, or don't have a time, clear any pending timer and exit.
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const makeUpdate = async () => {
      // *** FIX 1: Check the lock. If an update is already running, do nothing. ***
      if (isUpdatingRef.current) return;

      const f = Math.round(currTimelineFrameRef.current!);
      const tcStr = Timecode(f, projectFrameRate as FRAMERATE, false).toString();

      // No-op if timecode hasn't actually changed
      if (tcStr === lastTimecodeRef.current) return;

      try {
        // *** FIX 2: Set the lock and update the call time BEFORE the async call. ***
        isUpdatingRef.current = true;
        lastCallTimeRef.current = Date.now();
        lastTimecodeRef.current = tcStr;

        await SetDavinciPlayhead(tcStr);

      } catch (err) {
        console.error("Wails error:", err);
      } finally {
        // *** FIX 3: Always release the lock when done. ***
        isUpdatingRef.current = false;
      }
    };

    const now = Date.now();
    const elapsed = now - lastCallTimeRef.current;

    // If cooldown has passed, fire immediately.
    if (elapsed >= cooldown) {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      makeUpdate();
    } else {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        makeUpdate();
        timerRef.current = null;
      }, cooldown - elapsed);
    }

    // Cleanup on unmount or when deps change
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [
    displayedTime,
    projectFrameRate,
    isLoading,
    activeClip.startFrame,
    isPlaying,
  ]);

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
  const scrollPositionRef = useRef(0);
  const prevAudioUrlRef = useRef<string | undefined>(undefined);
  const isNewClipRef = useRef(false);

  const dimensions = useResizeObserver(waveformContainerRef)

  useEffect(() => {
    const audioUrlChanged = prevAudioUrlRef.current !== audioUrl;

    if (wavesurferRef.current) {
      if (!audioUrlChanged) { // Only save scroll if it's the same clip being resized
        scrollPositionRef.current = wavesurferRef.current.getScroll();
      } else { // If audioUrl changed, reset scroll position
        scrollPositionRef.current = 0;
        isNewClipRef.current = true; // Mark as new clip
      }
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }
    // Update prevAudioUrlRef for the next render
    prevAudioUrlRef.current = audioUrl;

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
    //setCurrentTime(0);

    const wsRegions = RegionsPlugin.create();
    regionsPluginRef.current = wsRegions;

    const wsMinimap = Minimap.create({
      container: minimapContainerRef.current,
      waveColor: "#444444",
      progressColor: "#444444",
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
      hideScrollbar: true,
      minPxPerSec: 15,
    };
    const handleGlobalMouseMove = (event: MouseEvent) => {
      if (!isPanningRef.current || !wavesurferRef.current) return;

      event.preventDefault();
      const wsInstance = wavesurferRef.current;
      const deltaX = event.clientX - panStartXRef.current;
      const newScrollLeft = panInitialScrollLeftRef.current - deltaX;
      wsInstance.setScroll(newScrollLeft);
    };

    const handleGlobalMouseUp = () => {
      if (!isPanningRef.current) return;

      isPanningRef.current = false;
      const scrollWrapper = wavesurferRef.current?.getWrapper();
      if (scrollWrapper) {
        scrollWrapper.style.cursor = originalCursorRef.current;
      }

      // Clean up immediately after the pan is finished
      document.removeEventListener("mousemove", handleGlobalMouseMove);
      document.removeEventListener("mouseup", handleGlobalMouseUp);
    };

    const handleWaveformMouseDown = (event: MouseEvent) => {
      const wsInstance = wavesurferRef.current;
      if (!wsInstance) return;

      // Middle mouse button
      if (event.button === 1) {
        event.preventDefault();
        event.stopPropagation();

        const scrollWrapper = wsInstance.getWrapper();
        if (!scrollWrapper) return;

        isPanningRef.current = true;
        panStartXRef.current = event.clientX;
        panInitialScrollLeftRef.current = wsInstance.getScroll();

        scrollWrapper.style.cursor = "grabbing";

        document.addEventListener("mousemove", handleGlobalMouseMove);
        document.addEventListener("mouseup", handleGlobalMouseUp);
      }
    };

    try {
      const ws = WaveSurfer.create(wsOptions);
      wavesurferRef.current = ws;

      // Restore time and scroll if it's a resize of the same clip
      if (!audioUrlChanged) {
        if (currentTimeRef.current > 0) {
          ws.setTime(currentTimeRef.current);
        }
        if (scrollPositionRef.current > 0) {
          ws.setScroll(scrollPositionRef.current);
        }
        setDisplayedTime(currentTimeRef.current);
        lastRenderedFrameRef.current = getFrameFromTime(currentTimeRef.current, projectFrameRate);
      }

      ws.on("ready", () => {
        setIsLoading(false);
        if (currTimecode && currTimecode.frameCount < maxTimecode.frameCount && currTimecode.frameCount > activeClip.startFrame) {
          const clipTime =
            (currTimecode.frameCount - activeClip.startFrame) /
            projectFrameRate;
          currentTimeRef.current = clipTime;
          setDisplayedTime(clipTime);
          ws.setTime(clipTime);
          lastRenderedFrameRef.current = getFrameFromTime(clipTime, projectFrameRate)
        } else if (currTimelineFrameRef.current) {
          const currTimelineFrameRefTC = Timecode(
            currTimelineFrameRef.current,
            projectFrameRate as FRAMERATE,
            false
          );

          if (currTimelineFrameRefTC.frameCount > maxTimecode.frameCount) {
            currentTimeRef.current = 0;
            setDisplayedTime(0);
            lastRenderedFrameRef.current = 0
          } else {
            const clipTime =
              (currTimelineFrameRefTC.frameCount - activeClip.startFrame) /
              projectFrameRate;
            console.log("we can keep current time! ", clipTime);
            currentTimeRef.current = clipTime;
            setDisplayedTime(clipTime);
            ws.setTime(clipTime);
            lastRenderedFrameRef.current = getFrameFromTime(clipTime, projectFrameRate)
          }
        } else {
          //console.log(`max tc: ${maxTimecode.frameCount}, curr tc: ${currTimecode.frameCount}`)
          // ws.setTime(0);
          //setTimecode(Timecode(activeClip.startFrame, projectFrameRate as FRAMERATE, false));
          currentTimeRef.current = 0;
          setDisplayedTime(0);
          lastRenderedFrameRef.current = -1;
        }

        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: activeClip.name,
            artist: 'mhm',
            album: 'HushCut App',
            artwork: [
              { src: 'logo512.png', sizes: '512x512', type: 'image/png' }
            ]
          });
        }
      });
      ws.on("play", () => {
        setIsPlaying(true);
        if (ws.isPlaying()) return;
        // cursed webkit fix
        if (ws.getVolume() != 1) {
          console.log("Volume was not 1, setting it to 1 webkit is cursed.");
          ws.setVolume(1);
        }
      });
      ws.on("pause", () => {
        if (isPlaying) {
          const timecode = currTimelineFrameRef.current || 0;
          console.log("timecode", timecode);
          setTimecode(Timecode(timecode, projectFrameRate as FRAMERATE, false))
        }

        setIsPlaying(false);
        if (!currTimelineFrameRef) return;


      });
      ws.on("finish", () => {
        setIsPlaying(false);
        ws.setTime(0);
        currentTimeRef.current = 0;
        setDisplayedTime(0);
        lastRenderedFrameRef.current = -1
      }); // Reset to start on finish

      ws.on("interaction", (newTime: number) => {
        ws.setTime(newTime); // Ensure wavesurfer time is set
        currentTimeRef.current = newTime;
        setDisplayedTime(newTime);
        lastRenderedFrameRef.current = getFrameFromTime(newTime, projectFrameRate);
      });

      ws.on("timeupdate", (time: number) => {
        currentTimeRef.current = time;
        const currentFrame = getFrameFromTime(time, projectFrameRate);

        // Only update state and trigger a re-render if the frame has changed
        if (currentFrame !== lastRenderedFrameRef.current) {
          lastRenderedFrameRef.current = currentFrame;
          setDisplayedTime(time);
        }

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

      ws.on("error", (err: Error | string) => {
        console.error("WaveSurfer error:", err);
        setIsLoading(false);
        setIsPlaying(false);
      });

      const scrollWrapper = ws.getWrapper();

      if (scrollWrapper) {
        originalCursorRef.current = scrollWrapper.style.cursor;

        scrollWrapper.addEventListener("mousedown", handleWaveformMouseDown);

        scrollWrapper.addEventListener("wheel", (e) => {
          // Only prevent default and zoom if it's a vertical scroll gesture
          if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

          e.preventDefault();

          const ws = wavesurferRef.current;
          if (!ws) return;

          // The exponential zoom factor. Adjust for sensitivity.
          const zoomFactor = Math.exp(-e.deltaY * 0.0025);

          const currentZoom = ws.options.minPxPerSec || 15;
          const newZoom = currentZoom * zoomFactor;

          // Set min and max zoom levels
          const maxZoom = 150; // or whatever max you prefer
          const minZoom = 1;
          const finalZoom = Math.max(minZoom, Math.min(newZoom, maxZoom));

          if (finalZoom == currentZoom) return;

          ws.zoom(finalZoom);

          // We still trigger this to update the silence regions, which is debounced.
          setZoomTrigger((p) => p + 1);

          // If it's primarily a horizontal scroll, we don't call preventDefault(),
          // allowing the browser's native horizontal scroll to work.
        });
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
      const minimapWrapper = minimapContainerRef.current;
      if (minimapWrapper) {
        minimapWrapper.addEventListener("wheel", (e) => {
          // Only prevent default and zoom if it's a vertical scroll gesture
          if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;

          e.preventDefault();

          const ws = wavesurferRef.current;
          if (!ws) return;

          // The exponential zoom factor. Adjust for sensitivity.
          const zoomFactor = Math.exp(-e.deltaY * 0.0025);

          const currentZoom = ws.options.minPxPerSec || 15;
          const newZoom = currentZoom * zoomFactor;

          // Set min and max zoom levels
          const maxZoom = 150; // or whatever max you prefer
          const minZoom = 1;
          const finalZoom = Math.max(minZoom, Math.min(newZoom, maxZoom));

          if (finalZoom == currentZoom) return;

          ws.zoom(finalZoom);

          // We still trigger this to update the silence regions, which is debounced.
          setZoomTrigger((p) => p + 1);
        });
      }

      const onMinimapDrag = (relativeX: number) => {
        const mainWs = wavesurferRef.current;
        if (!mainWs) return;
        const mainDuration = mainWs.getDuration();
        if (mainDuration > 0) {
          const newTime = relativeX * mainDuration;
          currentTimeRef.current = newTime;
          setDisplayedTime(newTime);
          // Update the last rendered frame immediately to prevent a double update
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
            currentTimeRef.current = newTime;
            setDisplayedTime(newTime);
            // Update the last rendered frame immediately to prevent a double update
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
      document.removeEventListener("mousemove", handleGlobalMouseMove);
      document.removeEventListener("mouseup", handleGlobalMouseUp);

      if (addRegionsTimeoutRef.current) {
        clearTimeout(addRegionsTimeoutRef.current);
        addRegionsTimeoutRef.current = null;
      }
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, [audioUrl, peakData, dimensions]);


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

      if (!sDataToProcess || sDataToProcess.length === 0 || duration <= 0) {
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
    const ws = wavesurferRef.current;
    if (ws) {
      const currentZoom = ws.options.minPxPerSec || 15;
      setZoomLevel(currentZoom);
    }
  }, [debouncedZoomTrigger]);

  const [isMouseInWaveform, setIsMouseInWaveform] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);

  const handleZoom = (newZoom: number) => {
    const ws = wavesurferRef.current;
    if (!ws) return;

    const minZoom = 1;
    const maxZoom = 150;
    const finalZoom = Math.max(minZoom, Math.min(newZoom, maxZoom));

    if (finalZoom !== ws.options.minPxPerSec) {
      ws.zoom(finalZoom);
      setZoomTrigger((p) => p + 1);
    }
  };

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
          className={`p-1.5 rounded flex items-center text-xs ${skipClass} whitespace-normal [@media(min-width:30rem)]:whitespace-nowrap`}
          title={skipTitle}
        >
          <RedoDotIcon size={21} className="mr-1" />
          {skipRegionsEnabled ? "Skip ON" : "Skip OFF"}
        </button>
      );
    });
  }, [toggleSkipRegions, skipClass, skipTitle]);

  const sliderClassName = "absolute top-2 right-2 z-10 transition-opacity duration-300 ease-in-out " + ((isMouseInWaveform || isPanningRef.current) ? "opacity-100" : "opacity-0 pointer-events-none");

  return (
    <div className="h-full flex flex-col">
      <div className="flex-grow min-h-0">
        <div
          ref={waveformContainerRef}
          className="h-full w-full bg-[#212126] border-1 border-b-0 rounded-tr-sm rounded-tl-sm box-border overflow-hidden relative"
          onMouseEnter={() => setIsMouseInWaveform(true)}
          onMouseLeave={() => setIsMouseInWaveform(false)}
        >
          <canvas className="absolute inset-0 z-0" />

          <div className={sliderClassName}>
            <ZoomSlider
              min={1}
              max={150}
              step={1}
              value={[zoomLevel]}
              onValueChange={(value) => {
                setZoomLevel(value[0]);
                handleZoom(value[0]);
              }}
              className="w-18 sm:w-24"
            />
          </div>

          {/* Threshold overlay line */}
          {isThresholdDragging && (
            <div
              className="absolute w-full h-[1px] rounded-full bg-teal-500 z-20 opacity-100 shadow-[0_0_10px_rgba(61,191,251,0.9)]"
              style={{ top: `${(Math.abs(threshold) / 60) * 100}%` }}
            />
          )}

          {isLoading && (
            <div className="absolute inset-0 flex items-end justify-end p-5 bg-gray-800/20 bg-opacity-50 text-white/60 z-10">
              <LoaderCircleIcon className="text-gray-500/40 animate-spin" />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-none border-0 mt-0 pt-1 overflow-hidden flex-shrink-0">
        <div
          ref={minimapContainerRef}
          className="max-h-[40px] w-full bg-transparent border-0 border-t-0 rounded-b-xs box-border overflow-hidden shadow-inner shadow-stone-900/50"
        ></div>
        <div className="flex items-center gap-1">
          <div className="w-full items-center flex justify-start py-2 gap-0.5 md:gap-2 p-1">
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
            {!isLoading && duration > 0 && <SkipButton />}
            {!isLoading && duration > 0 && (
              <TimecodeDisplay
                time={displayedTime}
                duration={duration}
                frameRate={projectFrameRate}
              />
            )}
          </div>
          <div className="flex justify-end pr-1 sm:pr-4 w-full gap-2 font-mono text-sm">
            <AudioWaveformIcon size={21} className="text-gray-500" /><span>{silenceData?.length}</span>
            <span className="text-gray-600 invisible sm:visible">|</span>
            <span className="hidden sm:flex space-x-0 gap-1">
              {formatDuration(totalSilenceDuration).map((part, index) => (
                <React.Fragment key={index}>
                  <span className="text-white">{part.value}</span>
                  <span className="text-gray-400">{part.unit}</span>
                  {index < formatDuration(totalSilenceDuration).length - 1 && " "}
                </React.Fragment>
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WaveformPlayer;
