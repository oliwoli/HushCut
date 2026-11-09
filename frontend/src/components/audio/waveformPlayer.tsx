import { AudioWaveformIcon, ChevronLeftIcon, ChevronRightIcon, FastForwardIcon, LoaderCircleIcon, PauseIcon, PlayIcon, RedoDotIcon, RotateCcwIcon, SkipForwardIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.js";

import { useClipParameter, useClipStore, useGlobalStore, usePlaybackStore, useTimecodeStore } from "@/stores/clipStore";

import { ActiveClip, SilencePeriod } from "@/types";
import { useSilenceData } from "@/hooks/useSilenceData";
//import { frameToTimecode, secToFrames } from "@/lib/utils";

import Timecode, { FRAMERATE } from "smpte-timecode";

import { SetDavinciPlayhead } from "@wails/go/main/App";
import { secToFrames, formatDuration } from "@/lib/utils";
import { useResizeObserver } from "@/hooks/hooks";
import { ZoomSlider } from "@/components/ui/zoomSlider";
import { useWaveformStore } from "@/stores/waveformStore";
import { useWaveformData } from "@/hooks/useWaveformData";

function usePlaybackControls({
  wavesurfer,
  onPlayPause,
  onRateChange,
  onJumpToPreviousSilencePoint,
  onJumpToNextSilencePoint,
}: {
  wavesurfer: WaveSurfer | null;
  onPlayPause: () => void;
  onRateChange: (newRate: number) => void;
  onJumpToPreviousSilencePoint: () => void;
  onJumpToNextSilencePoint: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore shortcuts if user is typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = e.key.toLowerCase();

      switch (key) {
        // Play and Pause
        case 'k':
          e.preventDefault();
          onPlayPause();
          break;

        // Decrease/Increase Playback Speed
        case 'j':
        case 'l': {
          e.preventDefault();
          if (!wavesurfer) return;

          const currentRate = wavesurfer.getPlaybackRate();
          const step = 0.5;
          let newRate;

          if (key === 'j') {
            // Decrease speed, clamped at 0.25x
            newRate = Math.max(0.25, currentRate - step);
          } else { // 'l'
            // Increase speed, clamped at 4x
            if (currentRate == 0.25) newRate = 0.5;
            else {
              newRate = Math.min(3, currentRate + step);
            }
          }

          wavesurfer.setPlaybackRate(newRate, true); // `true` preserves pitch
          onRateChange(newRate); // Notify component of the change
          break;
        }
        case 'arrowup':
          e.preventDefault();
          onJumpToPreviousSilencePoint();
          break;
        case 'arrowdown':
          e.preventDefault();
          onJumpToNextSilencePoint();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [wavesurfer, onPlayPause, onRateChange, onJumpToPreviousSilencePoint, onJumpToNextSilencePoint]);
}

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
    <span className="ml-2 flex gap-1.5 pt-1 text-xs font-mono tracking-tighter text-gray-400/80 mb-0.75">
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
  httpPort: number
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  activeClip,
  projectFrameRate,
  httpPort,
}) => {
  if (!activeClip || !projectFrameRate) {
    // You can return a placeholder here if you want, e.g., <div>Select a clip</div>
    return null;
  }

  const { peakData, cutAudioSegmentUrl } = useWaveformData(
    activeClip,
    projectFrameRate,
    httpPort
  );

  const setWaveform = useWaveformStore((s) => s.setWaveform);

  useEffect(() => {
    setWaveform(cutAudioSegmentUrl ?? undefined, peakData ?? null);
  }, [activeClip, cutAudioSegmentUrl, peakData, setWaveform]);


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
  const regionsPluginRef = useRef<InstanceType<typeof RegionsPlugin> | null>(null);
  const addRegionsTimeoutRef = useRef<any | null>(null); // Ref to manage the timeout for adding regions

  const setPlaybackState = usePlaybackStore.setState;

  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [isLoading, setIsLoading] = useState(true);

  const clipFrameDuration = activeClip.sourceEndFrame - activeClip.sourceStartFrame
  const duration = peakData?.duration || clipFrameDuration;

  const currTimecode = useTimecodeStore((s) => s.timecode);
  const setTimecode = useTimecodeStore((s) => s.setTimecode);
  const maxTimecode = Timecode(
    activeClip.startFrame + clipFrameDuration,
    projectFrameRate as FRAMERATE,
    false
  );

  //update the player time if timecode fits
  useEffect(() => {
    if (!wavesurferRef.current || !currTimecode) return;
    if (
      currTimecode.frameCount >= activeClip.startFrame &&
      currTimecode.frameCount < maxTimecode.frameCount
    ) {
      console.log("curr timecode: ", currTimecode);
      //const currTime = (currTimelineFrameRefTC.frameCount - activeClip.startFrame) / projectFrameRate;
      const clipTime =
        (currTimecode.frameCount - activeClip.startFrame) / projectFrameRate;
      console.log("we can use the timecode! ", clipTime);
      isUserSeekingRef.current = false;
      lastTimecodeRef.current = currTimecode.toString();
      currentTimeRef.current = clipTime;
      setDisplayedTime(clipTime);
      wavesurferRef.current?.setTime(clipTime);
    }
  }, [currTimecode]);

  const currentTimeRef = useRef(0);
  const [displayedTime, setDisplayedTime] = useState(0);
  const isUserSeekingRef = useRef(false);

  // Reset current time when activeClip changes
  useEffect(() => {
    currentTimeRef.current = 0;
    setDisplayedTime(0);
    isUserSeekingRef.current = false;
  }, [activeClip]);

  const currTimelineFrameRef = useRef<number | null>(null);
  const lastRenderedFrameRef = useRef(-1);

  const lastTimecodeRef = useRef<string | null>(null);
  const lastCallTimeRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const isUpdatingRef = useRef(false);
  const cooldown = 200; // ms

  // 1) Update the “current frame” ref in real time (always, even during playback)
  useEffect(() => {
    if (isLoading || displayedTime == null) return;
    const frame =
      secToFrames(displayedTime, projectFrameRate) + activeClip.startFrame;
    currTimelineFrameRef.current = frame;
  }, [displayedTime, isLoading, projectFrameRate, activeClip.startFrame]);

  // 2) Cooldown-style throttle, but only when paused and user-initiated
  useEffect(() => {
    if (isPlaying || isLoading || displayedTime == null || !isUserSeekingRef.current) {
      // If we're playing, loading, don't have a time, or this is NOT user-initiated seeking, clear any pending timer and exit.
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const makeUpdate = async () => {
      // *** FIX 1: Check the lock. If an update is already running, do nothing. ***
      if (isUpdatingRef.current) return;
      if (!isUserSeekingRef.current) return;

      const f = Math.round(currTimelineFrameRef.current!);
      const tcStr = Timecode(f, projectFrameRate as FRAMERATE, false).toString();

      // No-op if timecode hasn't actually changed
      if (tcStr === lastTimecodeRef.current) {
        isUserSeekingRef.current = false;
        return;
      }

      try {
        // *** FIX 2: Set the lock and update the call time BEFORE the async call. ***
        isUpdatingRef.current = true;
        lastCallTimeRef.current = Date.now();
        lastTimecodeRef.current = tcStr;
        isUserSeekingRef.current = false;

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

  const skipRegionsEnabled = useGlobalStore((s) => s.skipSilences);
  const setSkipSilences = useGlobalStore((s) => s.setSkipSilences);
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

  const [playbackRate, setPlaybackRate] = useState(1);

  const dimensions = useResizeObserver(waveformContainerRef)

  useEffect(() => {
    // if (!cutAudioSegmentUrl) return;
    if (!peakData) return;

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
      regionsPluginRef.current = null;
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

    if (wavesurferRef.current) { return }

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
      waveColor: peakData.duration < 1 ? "#9d9c9e" : "#6f7175",
      progressColor: peakData.duration < 1 ? "#9d9c9e" : "#6f7175",
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
        setPlaybackRate(1.0);
        setIsLoading(false);
        if (currTimecode && currTimecode.frameCount < maxTimecode.frameCount && currTimecode.frameCount >= activeClip.startFrame) {
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
            artist: 'HushCut',
            album: 'HushCut App',
            artwork: [
              {
                src: `http://localhost:${httpPort}/logo`,
                sizes: '512x512',
                type: 'image/png'
              }
            ]
          });
        }
      });
      ws.on("play", () => {
        isPlayingRef.current = true;
        setPlaybackState({ isPlaying: true });
        setIsPlaying(true);
        // cursed webkit fix
        ws.setVolume(1);
      });
      ws.on("pause", () => {
        if (wavesurferRef.current) {
          wavesurferRef.current.setPlaybackRate(1.0, true);
        }
        // Then, update the React state so the UI display is correct
        setPlaybackRate(1.0);
        if (isPlayingRef.current) {
          const pauseTime = wavesurferRef.current
            ? wavesurferRef.current.getCurrentTime()
            : currentTimeRef.current;
          currentTimeRef.current = pauseTime;
          setDisplayedTime(pauseTime);

          const frame =
            secToFrames(pauseTime, projectFrameRate) + activeClip.startFrame;
          currTimelineFrameRef.current = frame;

          const tc = Timecode(frame, projectFrameRate as FRAMERATE, false);
          setTimecode(tc);

          const tcStr = tc.toString();
          lastTimecodeRef.current = tcStr;
          isUserSeekingRef.current = false;
          SetDavinciPlayhead(tcStr).catch((err) => {
            console.error("Error setting DaVinci playhead on pause:", err);
          });
        }
        isPlayingRef.current = false;
        setPlaybackState({ isPlaying: false });
        setIsPlaying(false);
      });
      ws.on("finish", () => {
        isPlayingRef.current = false;
        setPlaybackState({ isPlaying: false });
        setIsPlaying(false);
        ws.setTime(0);
        currentTimeRef.current = 0;
        setDisplayedTime(0);
        lastRenderedFrameRef.current = -1;
      }); // Reset to start on finish

      ws.on("interaction", (newTime: number) => {
        isUserSeekingRef.current = true;
        ws.setTime(newTime); // Ensure wavesurfer time is set
        currentTimeRef.current = newTime;
        setDisplayedTime(newTime);
        lastRenderedFrameRef.current = getFrameFromTime(newTime, projectFrameRate);
      });

      ws.on("drag", () => {
        isUserSeekingRef.current = true;
      });

      ws.on("timeupdate", (time: number) => {
        setPlaybackState({ currentTime: time });
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

      ws.on("error", (err: Error) => {
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
          isUserSeekingRef.current = true;
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
            isUserSeekingRef.current = true;
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
        regionsPluginRef.current = null;
      }
    };
  }, [audioUrl, cutAudioSegmentUrl, peakData]);

  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    const currentZoom = ws.options.minPxPerSec;
    ws.zoom(currentZoom);
  }, [dimensions]);

  const [regionContextMenu, setRegionContextMenu] = useState<{
    x: number;
    y: number;
    modificationIds: string[];
  } | null>(null);

  useEffect(() => {
    if (!regionContextMenu) return;
    const handleClose = () => setRegionContextMenu(null);
    const handleKeyDownClose = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRegionContextMenu(null);
    };
    window.addEventListener("mousedown", handleClose);
    window.addEventListener("wheel", handleClose, { passive: true });
    window.addEventListener("keydown", handleKeyDownClose);
    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("wheel", handleClose);
      window.removeEventListener("keydown", handleKeyDownClose);
    };
  }, [regionContextMenu]);

  const handleResetModifiedRegion = useCallback(() => {
    if (!regionContextMenu || !activeClip?.id) return;
    useClipStore
      .getState()
      .removeRegionModifications(activeClip.id, regionContextMenu.modificationIds);
    setRegionContextMenu(null);
  }, [regionContextMenu, activeClip?.id]);

  const updateSilenceRegions = useCallback(
    (sDataToProcess: SilencePeriod[] | null | undefined) => {
      const currentRegionsPlugin = regionsPluginRef.current;
      if (!currentRegionsPlugin) return;
      const regionsContainerEl = (currentRegionsPlugin as any)
        .regionsContainer as HTMLElement | undefined;

      if (waveformContainerRef.current) {
        if (sDataToProcess && sDataToProcess.length > 200) {
          waveformContainerRef.current.classList.add("performance-mode");
        } else {
          waveformContainerRef.current.classList.remove("performance-mode");
        }
      }

      currentRegionsPlugin.clearRegions();
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
                const isModified = Boolean(period.isModified);
                const baseRegionId = `silence-marker_${index}_${period.start}-${period.end}`;
                const regionId = isModified
                  ? `${baseRegionId} region-modified`
                  : baseRegionId;

                const region = regionsPluginRef.current!.addRegion({
                  id: regionId,
                  start: finalStart,
                  end: finalEnd,
                  color: isModified
                    ? "rgba(139, 92, 246, 0.25)"
                    : "rgba(250, 7, 2, 0.15)",
                  drag: false,
                  resize: true,
                  minLength: 0.01,
                });

                const el = region.element;
                if (el) {
                  // Allow left-clicks and drag-to-seek on the region body (not on handles) to pass through to WaveSurfer
                  el.addEventListener(
                    "pointerdown",
                    (ev: PointerEvent) => {
                      if (ev.target === el && ev.button === 0) {
                        Object.defineProperty(ev, "button", {
                          value: -1,
                          configurable: true,
                        });
                      }
                    },
                    { capture: true }
                  );
                  el.addEventListener(
                    "pointerdown",
                    (ev: PointerEvent) => {
                      if (ev.target === el && ev.button === -1) {
                        Object.defineProperty(ev, "button", {
                          value: 0,
                          configurable: true,
                        });
                      }
                    },
                    { capture: false }
                  );

                  if (
                    isModified &&
                    period.modificationIds &&
                    period.modificationIds.length > 0
                  ) {
                    el.addEventListener("contextmenu", (e: MouseEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRegionContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        modificationIds: period.modificationIds || [],
                      });
                    });
                  }
                }

                const setHandlesVisible = (visible: boolean) => {
                  if (!region.element) return;
                  const handles = region.element.querySelectorAll(
                    '[part*="region-handle"]'
                  );
                  handles.forEach((h) => {
                    const currentPart = h.getAttribute("part") || "";
                    const tokens = currentPart.split(/\s+/).filter(Boolean);
                    const hasToken = tokens.includes("region-handle-visible");
                    if (visible && !hasToken) {
                      h.setAttribute(
                        "part",
                        [...tokens, "region-handle-visible"].join(" ")
                      );
                    } else if (!visible && hasToken) {
                      h.setAttribute(
                        "part",
                        tokens
                          .filter((t) => t !== "region-handle-visible")
                          .join(" ")
                      );
                    }
                  });
                };

                region.on("over", () => setHandlesVisible(true));
                region.on("leave", () => setHandlesVisible(false));

                region.on("update-end", (side?: "start" | "end") => {
                  if (!activeClip?.id) return;

                  region.setOptions({
                    color: "rgba(139, 92, 246, 0.25)",
                    id: `${baseRegionId} region-modified`,
                  });

                  const fallbackCenter =
                    ((period.rawStart ?? period.start) +
                      (period.rawEnd ?? period.end)) /
                    2;

                  if (side === "start") {
                    const newSourceStart =
                      region.start + clipOriginalStartSecondsRef.current;
                    const baseStart = period.baseStart ?? period.start;
                    const deltaStart = newSourceStart - baseStart;
                    const centerTime = period.startCenterTime ?? fallbackCenter;
                    useClipStore
                      .getState()
                      .upsertRegionModification(activeClip.id, {
                        id: period.startModId,
                        centerTime,
                        deltaStart,
                      });
                  } else if (side === "end") {
                    const newSourceEnd =
                      region.end + clipOriginalStartSecondsRef.current;
                    const baseEnd = period.baseEnd ?? period.end;
                    const deltaEnd = newSourceEnd - baseEnd;
                    const centerTime = period.endCenterTime ?? fallbackCenter;
                    useClipStore
                      .getState()
                      .upsertRegionModification(activeClip.id, {
                        id: period.endModId,
                        centerTime,
                        deltaEnd,
                      });
                  }
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
    [clipOriginalStartSeconds, duration, activeClip?.id]
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
    if (wavesurferRef.current && !isLoading) {
      const promise = wavesurferRef.current.playPause();
      if (promise) {
        promise.catch((err) => {
          if (err.name !== "AbortError") {
            console.error("Playback error:", err);
          }
        });
      }
    }
  }, [isLoading]);

  const getSilencePoints = useCallback(() => {
    if (!silenceData) return [];
    const points: number[] = [];
    silenceData.forEach(period => {
      points.push(period.start - clipOriginalStartSecondsRef.current);
      points.push(period.end - clipOriginalStartSecondsRef.current);
    });
    return points.sort((a, b) => a - b);
  }, [silenceData]);

  const handleJumpToPreviousSilencePoint = useCallback(() => {
    if (!wavesurferRef.current || !silenceData || silenceData.length === 0) return;

    const currentTime = wavesurferRef.current.getCurrentTime();
    const points = getSilencePoints();

    const epsilon = 0.001; // Small value to avoid floating point issues and ensure movement

    let targetTime = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i] < currentTime - epsilon) {
        targetTime = points[i];
        break;
      }
    }
    isUserSeekingRef.current = true;
    currentTimeRef.current = targetTime;
    setDisplayedTime(targetTime);
    wavesurferRef.current.setTime(targetTime);
  }, [silenceData, getSilencePoints]);

  const handleJumpToNextSilencePoint = useCallback(() => {
    if (!wavesurferRef.current || !silenceData || silenceData.length === 0) return;

    const currentTime = wavesurferRef.current.getCurrentTime();
    const points = getSilencePoints();

    const epsilon = 0.001; // Small value to avoid floating point issues and ensure movement

    let targetTime = wavesurferRef.current.getDuration();
    for (let i = 0; i < points.length; i++) {
      if (points[i] > currentTime + epsilon) {
        targetTime = points[i];
        break;
      }
    }
    isUserSeekingRef.current = true;
    currentTimeRef.current = targetTime;
    setDisplayedTime(targetTime);
    wavesurferRef.current.setTime(targetTime);
  }, [silenceData, getSilencePoints]);

  usePlaybackControls({
    wavesurfer: wavesurferRef.current,
    onPlayPause: handlePlayPause,
    onRateChange: setPlaybackRate,
    onJumpToPreviousSilencePoint: handleJumpToPreviousSilencePoint,
    onJumpToNextSilencePoint: handleJumpToNextSilencePoint,
  });

  const toggleSkipRegions = useCallback(
    () => setSkipSilences(!useGlobalStore.getState().skipSilences),
    [setSkipSilences]
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
          className={`p-1.5 rounded flex items-center text-xs whitespace-nowrap gap-1`}
          title={skipTitle}
        >
          <RedoDotIcon className={`mr-1 ${skipClass} w-5 h-5`} />
          <span className={`hidden [@media(min-width:30rem)]:flex ${skipRegionsEnabled ? "text-stone-300" : "text-stone-500"} w-12 `}>
            {skipRegionsEnabled ? (
              <div><span className="text-stone-400 font-light">Skip</span> <span className="font-medium text-stone-300">ON</span></div>
            )
              : "Skip OFF"}
          </span>
        </button>
      );
    });
  }, [toggleSkipRegions, skipClass, skipTitle, skipRegionsEnabled]);

  const sliderClassName =
    "absolute top-2 right-2 z-10 transition-opacity duration-300 ease-in-out";

  const maxZoomSteps = 10;
  const handleZoomInClick = () => {
    const currentZoom = zoomLevel;
    const newZoom = Math.min(150, currentZoom + 150 / maxZoomSteps);
    handleZoom(newZoom);
    setZoomLevel(newZoom);
  };

  const handleZoomOutClick = () => {
    const currentZoom = zoomLevel;
    const newZoom = Math.max(1, currentZoom - 150 / maxZoomSteps);
    handleZoom(newZoom);
    setZoomLevel(newZoom);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="grow min-h-0 min-w-0">
        <div
          ref={waveformContainerRef}
          id="waveform"
          className="h-full w-full bg-[#212126] border border-b-0 rounded-tr-sm rounded-tl-sm box-border overflow-hidden relative min-w-1 min-h-1"
        >
          <canvas className="absolute inset-0 z-0" />

          <div
            className={`${sliderClassName} p-1 ${!isPlaying && !isThresholdDragging ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
          >
            <ZoomSlider
              min={1}
              max={150}
              step={1}
              value={[zoomLevel]}
              onValueChange={(value) => {
                setZoomLevel(value[0]);
                handleZoom(value[0]);
              }}
              onZoomIn={handleZoomInClick}
              onZoomOut={handleZoomOutClick}
              className="w-18 sm:w-24"
            />
          </div>

          {/* Threshold overlay line */}
          {isThresholdDragging && (
            <div
              className="absolute w-full h-px rounded-full bg-teal-500 z-20 opacity-100 shadow-[0_0_10px_rgba(61,191,251,0.9)]"
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

      <div className="rounded-none border-0 mt-0 pt-1 overflow-hidden shrink-0">
        <div
          ref={minimapContainerRef}
          className="max-h-10 w-full bg-[#131316] border rounded-b-xs box-border overflow-hidden"
        ></div>
        <div className="flex items-center gap-1">
          <div className="w-full items-center flex justify-start py-2 gap-0.5 md:gap-2 p-1">
            <button
              onClick={handlePlayPause}
              disabled={isLoading || !duration}
              className="text-gray-400 hover:text-amber-50 focus-visible:outline-0 focus-visible:text-amber-50"
            >
              {isPlaying ? (
                <PauseIcon className="p-1.5 w-8 h-8" />
              ) : (
                <PlayIcon className="p-1.5 w-8 h-8" />
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
          {!isLoading && playbackRate !== 1 && (
            <div className="p-1.5 gap-1 rounded flex items-center text-xs font-mono text-zinc-400" title="Playback Speed">
              {playbackRate > 1 ?
                (<FastForwardIcon className="text-amber-500 w-4 h-4" />) :
                (<FastForwardIcon className="text-teal-500 rotate-180 w-4 h-4" />)
              }

              <span>{playbackRate.toFixed(2)}x</span>
            </div>
          )}
          <div className="flex justify-end pr-2 sm:pr-2 w-full gap-2 font-mono text-sm items-center">
            <div className="flex justify-end pr-0 w-full gap-2 font-mono text-sm items-center">
              <div className="flex items-center gap-1 text-sm">
                {silenceData && silenceData.length > 0 && (
                  <button
                    onClick={handleJumpToPreviousSilencePoint}
                    className="text-gray-500 hover:text-zinc-300"
                    title="Jump to previous silence point"
                  >
                    <ChevronLeftIcon className="w-4 h-4" />
                  </button>
                )}
                <AudioWaveformIcon className="text-gray-500 w-5 h-5" />
                {silenceData && silenceData.length > 0 && (
                  <button
                    onClick={handleJumpToNextSilencePoint}
                    className="text-gray-500 hover:text-zinc-300"
                    title="Jump to next silence point"
                  >
                    <ChevronRightIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
              <span>{silenceData?.length}</span>
              <span className="text-gray-600 invisible sm:visible">|</span>
              <span className="hidden sm:flex space-x-0 gap-1">
                {formatDuration(totalSilenceDuration).map((part, index) => (
                  <React.Fragment key={index}>
                    <span className="text-white">{part.value}</span>
                    <span className="text-gray-400">{part.unit}</span>
                    {index < formatDuration(totalSilenceDuration).length - 1 &&
                      " "}
                  </React.Fragment>
                ))}
              </span>
            </div>
          </div>
        </div>
      </div>
      {regionContextMenu &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: Math.min(regionContextMenu.y, window.innerHeight - 52),
              left: Math.min(regionContextMenu.x, window.innerWidth - 190),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-popover text-popover-foreground z-50 min-w-[10rem] overflow-hidden rounded-md border p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          >
            <button
              type="button"
              onClick={handleResetModifiedRegion}
              className="hover:bg-accent hover:text-accent-foreground relative flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none"
            >
              <RotateCcwIcon className="h-4 w-4 text-violet-400" />
              <span>Reset Region</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};

export default WaveformPlayer;
