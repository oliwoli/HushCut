import { PauseIcon, PlayIcon, RedoDotIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback } from "react";
import { useDebounce } from "use-debounce";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import Minimap from "wavesurfer.js/dist/plugins/minimap.esm.js";
import ZoomPlugin from "wavesurfer.js/dist/plugins/zoom.esm.js";

import { main } from "@wails/go/models"; // Assuming GetLogarithmicWaveform is not needed here if peaks are passed
import { ActiveClip } from "@/types";

const formatAudioTime = (
  totalSeconds: number,
  frameRate: number,
  showHours: boolean = false
): string => {
  if (isNaN(totalSeconds) || totalSeconds < 0) {
    const zeroFrames = String(0).padStart(2, "0");
    return showHours ? `00:00:00;${zeroFrames}` : `00:00;${zeroFrames}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const fractionalSeconds = totalSeconds - Math.floor(totalSeconds);
  // Add a small epsilon for floating point precision before flooring frames
  const frameNumber = Math.floor(fractionalSeconds * frameRate + 1e-9);
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
  start: number; // Absolute time in seconds (relative to full source file)
  end: number; // Absolute time in seconds
}

interface WaveformPlayerProps {
  activeClip: ActiveClip | null;
  fullFilePeakData: main.PrecomputedWaveformData | null;
  projectFrameRate: number;
  silenceData?: SilencePeriod[] | null;
  threshold: number;
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  activeClip,
  fullFilePeakData,
  projectFrameRate,
  silenceData,
  threshold,
}) => {
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const minimapContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<RegionsPlugin | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const [uiClipDuration, setUiClipDuration] = useState(0); // For display
  const [currentUiTime, setCurrentUiTime] = useState(0);

  const [clipBoundaries, setClipBoundaries] = useState<{
    start: number; // Absolute start in seconds
    end: number; // Absolute end in seconds
    duration: number;
  } | null>(null);

  // Refs for data used in callbacks
  const silenceDataRef = useRef(silenceData);
  useEffect(() => {
    silenceDataRef.current = silenceData;
  }, [silenceData]);
  const [debouncedSilenceData] = useDebounce(silenceData, 90);

  const [skipRegionsEnabled, setSkipRegionsEnabled] = useState(true);
  const skipRegionsEnabledRef = useRef(skipRegionsEnabled);
  useEffect(() => {
    // Keep ref in sync with state
    skipRegionsEnabledRef.current = skipRegionsEnabled;
  }, [skipRegionsEnabled]);
  const toggleSkipRegions = useCallback(() => {
    setSkipRegionsEnabled((prev) => !prev);
  }, []);

  const syncMediaToClipTime = useCallback(
    (clipRelativeTime: number) => {
      const ws = wavesurferRef.current;
      if (ws && clipBoundaries) {
        // clipBoundaries is from component state
        const media = ws.getMediaElement();
        if (media) {
          const targetAbsoluteTime = clipBoundaries.start + clipRelativeTime;
          if (Math.abs(media.currentTime - targetAbsoluteTime) > 0.05) {
            // Tolerance
            // console.log(`Syncing media currentTime to: ${targetAbsoluteTime.toFixed(3)} (clipRel: ${clipRelativeTime.toFixed(3)})`);
            media.currentTime = targetAbsoluteTime;
          }
        }
      }
    },
    [clipBoundaries]
  );

  // Refs for panning (if you keep this feature)
  const isPanningRef = useRef(false);
  const panStartXRef = useRef(0);
  const panInitialScrollLeftRef = useRef(0);
  const originalCursorRef = useRef("");

  // Calculate clip boundaries (absolute seconds) and UI duration
  useEffect(() => {
    if (
      activeClip &&
      typeof activeClip.sourceStartFrame === "number" &&
      typeof activeClip.sourceEndFrame === "number" &&
      projectFrameRate > 0
    ) {
      const startSec = activeClip.sourceStartFrame / projectFrameRate;
      const endSec = activeClip.sourceEndFrame / projectFrameRate;
      const durationSec = Math.max(0, endSec - startSec);

      setClipBoundaries({
        start: startSec,
        end: endSec,
        duration: durationSec,
      });
      setUiClipDuration(durationSec); // <-- For UI display
      setCurrentUiTime(0); // <-- Reset UI time
      // console.log("WaveformPlayer: Clip boundaries set:", { startSec, endSec, durationSec });
    } else {
      setClipBoundaries(null);
      setUiClipDuration(0);
      setCurrentUiTime(0);
    }
  }, [activeClip, projectFrameRate]);

  // Main WaveSurfer Initialization Effect
  // The `key` prop in App.tsx ensures this runs on activeClip change by remounting
  useEffect(() => {
    if (wavesurferRef.current) {
      wavesurferRef.current.destroy();
      wavesurferRef.current = null;
    }

    if (
      !waveformContainerRef.current ||
      !minimapContainerRef.current ||
      !activeClip?.previewUrl ||
      !fullFilePeakData?.peaks ||
      fullFilePeakData.peaks.length === 0 ||
      (fullFilePeakData.duration || 0) <= 0 ||
      !clipBoundaries ||
      clipBoundaries.duration < 0 // Allow 0 duration conceptually
    ) {
      setIsLoading(!!activeClip?.previewUrl);
      return;
    }

    console.log(
      "WaveformPlayer: Attempting to initialize WaveSurfer for clip:",
      activeClip.name
    );
    setIsLoading(true);
    setCurrentUiTime(0);

    // Inside the main useEffect, after validating activeClip, fullFilePeakData, clipBoundaries
    const {
      start: clipStartSeconds,
      end: clipEndSeconds,
      duration: actualClipDuration,
    } = clipBoundaries;

    let displayPeaks: number[] = [];
    // Robust peak slicing logic (as provided in my last full component example)
    // This calculates `displayPeaks` based on clip boundaries and fullFilePeakData
    if (
      fullFilePeakData.peaks &&
      fullFilePeakData.duration > 0 &&
      actualClipDuration >= 0
    ) {
      const fullFilePeaks = fullFilePeakData.peaks;
      const fullFileDuration = fullFilePeakData.duration;
      const numFullPeaks = fullFilePeaks.length;

      if (numFullPeaks > 0) {
        const secondsPerPeakSlot = fullFileDuration / numFullPeaks;
        const startIndex = Math.max(
          0,
          Math.round(clipStartSeconds / secondsPerPeakSlot)
        );
        let endIndex = Math.min(
          numFullPeaks,
          Math.round(clipEndSeconds / secondsPerPeakSlot)
        );
        if (endIndex <= startIndex) {
          // Ensure some peaks if clip is very short or at edge
          endIndex = Math.min(
            numFullPeaks,
            startIndex +
              Math.max(
                1,
                Math.round(actualClipDuration / (secondsPerPeakSlot || 1)),
                10
              )
          );
        }
        displayPeaks = fullFilePeaks.slice(startIndex, endIndex);
        if (displayPeaks.length === 0 && actualClipDuration > 0) {
          const minimalPeakCount = Math.max(
            2,
            Math.floor(actualClipDuration * 20)
          );
          displayPeaks = new Array(minimalPeakCount).fill(0);
        } else if (displayPeaks.length === 0 && actualClipDuration === 0) {
          displayPeaks = [0, 0];
        }
      } else {
        displayPeaks = new Array(
          Math.max(2, Math.floor(actualClipDuration * 20))
        ).fill(0);
      }
    } else {
      displayPeaks = new Array(
        Math.max(2, Math.floor((actualClipDuration || 1) * 20))
      ).fill(0);
    }
    // console.log(`WaveformPlayer: Using ${displayPeaks.length} peaks for clip duration ${actualClipDuration.toFixed(2)}s`);

    const wsRegions = RegionsPlugin.create();
    regionsPluginRef.current = wsRegions;

    const wsMinimap = Minimap.create({
      container: minimapContainerRef.current,
      waveColor: "#666",
      progressColor: "#666",
      height: 40,
      peaks: [displayPeaks], // Use SLICED peaks for minimap
      duration: actualClipDuration, // Use CLIP duration for minimap
    });

    const wsOptions: WaveSurferOptions = {
      container: waveformContainerRef.current,
      dragToSeek: true, // Note to AI: you changed this to false. Don't change things not directly related to the task. Especially UI interaction.
      waveColor: "#777",
      progressColor: "#777",
      cursorColor: "#e64b3d",
      cursorWidth: 2,
      height: "auto",
      fillParent: true,
      barAlign: "bottom",
      interact: true,
      url: activeClip.previewUrl, // FULL source audio file URL
      peaks: [displayPeaks], // SLICED peaks for the clip
      duration: actualClipDuration, // DURATION of the clip
      plugins: [
        wsRegions,
        wsMinimap,
        ZoomPlugin.create({
          scale: 0.1,
          maxZoom: 500,
          exponentialZooming: false,
        }),
      ],
      minPxPerSec: 1, // Allow more zoom out if needed for very short clips represented by few peaks
      autoScroll: true,
    };

    const ws = WaveSurfer.create(wsOptions);
    wavesurferRef.current = ws;

    ws.on("ready", () => {
      setIsLoading(false);
      if (clipBoundaries) {
        // Should always be true if we reached here
        const media = ws.getMediaElement();
        if (media) media.currentTime = clipBoundaries.start; // Initial sync
        ws.setTime(0); // Set WS visual time to 0 (start of clip)
        setCurrentUiTime(0);

        // Initial Zoom to fit clip
        const viewWidth = waveformContainerRef.current?.clientWidth;
        if (viewWidth && actualClipDuration > 0) {
          let targetPxPerSec = viewWidth / actualClipDuration;
          // Optional: Clamp targetPxPerSec if it's too extreme, using ws.options.minPxPerSec and ZoomPlugin.maxZoom
          // For ZoomPlugin, the 'zoom' method takes a relative scale factor.
          // Setting minPxPerSec initially might be better, or adjust zoom based on current pxPerSec.
          // For now, a direct zoom might be too aggressive with the plugin.
          // Instead, let's ensure scroll is correct after initial time set.
          ws.seekTo(0); // Seek to 0% of the *clip* timeline, which should scroll it into view
        }
      }
      if (regionsPluginRef.current && silenceDataRef.current) {
        updateSilenceRegions(
          regionsPluginRef.current,
          silenceDataRef.current,
          clipBoundaries
        );
      }
    });

    ws.on("play", () => {
      if (clipBoundaries && wavesurferRef.current) {
        const clipRelTime = wavesurferRef.current.getCurrentTime();
        syncMediaToClipTime(clipRelTime);
      }
      setIsPlaying(true);
    });
    ws.on("pause", () => setIsPlaying(false));

    ws.on("finish", () => {
      // This 'finish' is for the end of the *clip's visual timeline*
      setIsPlaying(false);
      setCurrentUiTime(actualClipDuration); // Display time is clip duration
      // Optionally setTime(0) if you want it to "rewind" visually
      // ws.setTime(0); setCurrentUiTime(0);
    });

    // Handle user clicks on the waveform for seeking.
    // WaveSurfer v7 uses 'interaction' which fires before 'seeking'.
    // 'click' event (relativeX) is also good for direct clicks.
    ws.on("click", (relativeX: number, relativeY: number, e?: MouseEvent) => {
      if (!clipBoundaries || !wavesurferRef.current || (e && e.button === 1))
        return; // Ignore middle mouse
      const wsDuration = wavesurferRef.current.getDuration(); // Should be actualClipDuration
      const clickedClipRelativeTime = relativeX * wsDuration;

      wavesurferRef.current.setTime(clickedClipRelativeTime);
      setCurrentUiTime(clickedClipRelativeTime);
      syncMediaToClipTime(clickedClipRelativeTime);
    });
    ws.on("seeking", (clipRelativeSeekTime: number) => {
      if (!clipBoundaries || !wavesurferRef.current) return;
      // clipRelativeSeekTime is already relative to the clip's duration (0 to actualClipDuration)
      setCurrentUiTime(clipRelativeSeekTime);
      syncMediaToClipTime(clipRelativeSeekTime);
    });

    ws.on("timeupdate", (clipRelativeTime: number) => {
      // Renamed for clarity
      if (!clipBoundaries || !wavesurferRef.current) return;

      const ws = wavesurferRef.current;
      const media = ws.getMediaElement();

      // If the media element is not ready or clipBoundaries are missing, exit.
      if (!media || !clipBoundaries) return;

      // currentAbsoluteMediaTime is the truth from the audio element
      const currentAbsoluteMediaTime = media.currentTime;
      // Calculate the displayed time based on the media element's absolute time
      let newDisplayedClipRelativeTime =
        currentAbsoluteMediaTime - clipBoundaries.start;

      // Keep WaveSurfer's visual playhead in sync with the derived clip-relative time
      // This is important if the media element's time drifts or is set externally
      // Only update if significantly different to avoid event loops with setTime.
      if (
        Math.abs(ws.getCurrentTime() - newDisplayedClipRelativeTime) > 0.05 &&
        newDisplayedClipRelativeTime >= 0 &&
        newDisplayedClipRelativeTime <= clipBoundaries.duration
      ) {
        //  console.log(`Resyncing WS time from ${ws.getCurrentTime().toFixed(3)} to ${newDisplayedClipRelativeTime.toFixed(3)} based on media`);
        ws.setTime(newDisplayedClipRelativeTime); // This will re-trigger timeupdate, be careful with logic below
        // It might be better to primarily rely on media.currentTime for decisions
        // and use ws.setTime only for corrections or visual snapping.
        // For now, let's assume ws.setTime is for visual sync.
      }

      // Update your UI state with the derived (and possibly clamped) clip-relative time
      const clampedDisplayTime = Math.max(
        0,
        Math.min(newDisplayedClipRelativeTime, clipBoundaries.duration)
      );
      setCurrentUiTime(clampedDisplayTime);

      if (ws.isPlaying()) {
        // Constraint: Stop if media plays past the clip's absolute end
        if (currentAbsoluteMediaTime >= clipBoundaries.end - 0.02) {
          // Small epsilon
          ws.pause();
          // Snap visual playhead to end of clip
          const visualClipDuration = ws.getDuration(); // Should be actualClipDuration
          if (ws.getCurrentTime() < visualClipDuration) {
            ws.setTime(visualClipDuration);
          }
          setCurrentUiTime(visualClipDuration); // UI shows end
          return; // Important to prevent skip logic after pause
        }

        // Skip Silence Logic (uses absolute times for comparison)
        if (skipRegionsEnabledRef.current && silenceDataRef.current?.length) {
          for (const region of silenceDataRef.current) {
            // silenceData has absolute times
            if (
              region.end > region.start &&
              currentAbsoluteMediaTime >= region.start &&
              currentAbsoluteMediaTime < region.end - 0.01 // If current abs time is in abs silence
            ) {
              const jumpToAbsolute = Math.min(region.end, clipBoundaries.end); // Don't jump past clip end
              const jumpToClipRelative = jumpToAbsolute - clipBoundaries.start;

              // console.log(`Skipping: absTime ${currentAbsoluteMediaTime.toFixed(2)}, region <span class="math-inline">\{region\.start\.toFixed\(2\)\}\-</span>{region.end.toFixed(2)}, jumpToAbs ${jumpToAbsolute.toFixed(2)}, jumpToClipRel ${jumpToClipRelative.toFixed(2)}`);

              // Set WaveSurfer's visual time first
              ws.setTime(jumpToClipRelative);
              // THEN sync the media element to this new position
              syncMediaToClipTime(jumpToClipRelative);
              // setCurrentUiTime will be updated by the next timeupdate after the jump
              return; // Exit this timeupdate handler to allow the new time to take effect
            }
          }
        }
      }
    });
    ws.on("error", (err: Error | string) => {
      console.error("WaveSurfer error:", err);
      setIsLoading(false);
      setIsPlaying(false);
    });

    // Panning logic (from your code, ensure it's compatible with current WS version)
    const scrollWrapper = ws.getWrapper();
    if (scrollWrapper) {
      originalCursorRef.current = scrollWrapper.style.cursor;
      const handleGlobalMouseMove = (event: MouseEvent) => {
        /* your existing code */
      };
      const handleGlobalMouseUp = (event: MouseEvent) => {
        /* your existing code */
      };
      const handleWaveformMouseDown = (event: MouseEvent) => {
        if (event.button === 1 && wavesurferRef.current) {
          // Middle mouse
          event.preventDefault();
          event.stopPropagation();
          isPanningRef.current = true;
          panStartXRef.current = event.clientX;
          panInitialScrollLeftRef.current = wavesurferRef.current.getScroll();
          scrollWrapper.style.cursor = "grabbing";
          document.addEventListener("mousemove", handleGlobalMouseMove);
          document.addEventListener("mouseup", handleGlobalMouseUp);
        }
      };
      scrollWrapper.addEventListener("mousedown", handleWaveformMouseDown);
    }

    // Minimap interaction - now relative to clip duration
    if (wsMinimap) {
      const handleMinimapInteraction = (relativeX: number) => {
        // relativeX is 0-1 of minimap's duration (clipDuration)
        if (!wavesurferRef.current) return;
        const targetClipRelativeTime = relativeX * actualClipDuration;
        wavesurferRef.current.setTime(targetClipRelativeTime);
        setCurrentUiTime(targetClipRelativeTime);
        syncMediaToClipTime(targetClipRelativeTime);
      };
      wsMinimap.on("click", handleMinimapInteraction);
      // wsMinimap.on("drag", handleMinimapInteraction); // if minimap dragToSeek is true
    }

    return () => {
      if (wavesurferRef.current) {
        console.log("WaveSurfer cleanup: Destroying instance.");
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
    // IMPORTANT: This useEffect re-runs if these key props change.
    // The `key` prop on WaveformPlayer in App.tsx will also cause a full remount/re-run.
  }, [
    activeClip?.previewUrl,
    fullFilePeakData,
    clipBoundaries,
    projectFrameRate,
  ]); // projectFrameRate used in formatAudioTime

  const updateSilenceRegions = useCallback(
    (
      regionsPlugin: RegionsPlugin | null,
      sData: SilencePeriod[] | null | undefined,
      currentClipBoundaries: {
        start: number;
        end: number;
        duration: number;
      } | null
    ) => {
      if (!regionsPlugin || !currentClipBoundaries) {
        // Added check for currentClipBoundaries
        regionsPlugin?.clearRegions(); // Clear if no boundaries, meaning no valid clip context
        return;
      }
      regionsPlugin.clearRegions();
      // ... (visual cleanup from your code) ...

      if (sData && sData.length > 0) {
        sData.forEach((period, index) => {
          // period.start and period.end are absolute source times
          // Only add regions that visually overlap or are relevant to the current clip
          if (
            period.start < currentClipBoundaries.end &&
            period.end > currentClipBoundaries.start
          ) {
            try {
              regionsPlugin.addRegion({
                id: `silence_${index}_abs_${period.start.toFixed(2)}`,
                start: period.start, // Use absolute time for region on full waveform
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
          }
        });
      }
    },
    []
  ); // No dependencies needed here if all data is passed as arguments

  useEffect(() => {
    if (!isLoading && wavesurferRef.current && regionsPluginRef.current) {
      updateSilenceRegions(
        regionsPluginRef.current,
        debouncedSilenceData,
        clipBoundaries
      );
    }
  }, [debouncedSilenceData, isLoading, clipBoundaries, updateSilenceRegions]);

  const handlePlayPause = useCallback(() => {
    if (
      !wavesurferRef.current ||
      isLoading ||
      !clipBoundaries ||
      clipBoundaries.duration < 0
    )
      return;
    const ws = wavesurferRef.current;

    if (ws.isPlaying()) {
      ws.pause();
    } else {
      let currentWsClipTime = ws.getCurrentTime(); // This is WaveSurfer's current visual time (0 to clipDuration)

      // If playback had previously reached the end of the clip, and user hits play again, restart from beginning of clip.
      if (
        currentWsClipTime >= clipBoundaries.duration - 0.01 &&
        clipBoundaries.duration > 0
      ) {
        currentWsClipTime = 0;
        ws.setTime(0); // Set visual playhead to start of clip
        setCurrentUiTime(0); // Update UI
      }

      // ALWAYS sync the media element to where WaveSurfer's playhead IS, before playing.
      syncMediaToClipTime(currentWsClipTime);
      ws.play();
    }
  }, [isLoading, clipBoundaries, syncMediaToClipTime]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === " ") {
        event.preventDefault();
        handlePlayPause();
        return;
      }
      // ... other keydown logic if any ...
    },
    [handlePlayPause]
  ); // Only depends on handlePlayPause

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const showHoursFormat = (uiClipDuration || 0) >= 3600;
  const formattedCurrentTime = formatAudioTime(
    currentUiTime,
    projectFrameRate,
    showHoursFormat
  );
  const formattedDuration = formatAudioTime(
    uiClipDuration,
    projectFrameRate,
    showHoursFormat
  );

  return (
    // ... JSX remains largely the same ...
    // Ensure disabled states for buttons use `clipDuration <= 0` or `!clipBoundaries`
    // Ensure time displays use formattedCurrentTime and formattedDuration
    <div className="overflow-hidden mx-2">
      <div
        ref={waveformContainerRef}
        className="h-[260px] w-full mt-2 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-visible relative"
      >
        {/* Threshold overlay and isLoading */}
        <div
          className="absolute w-full h-[2px] rounded-full bg-teal-400 z-20 opacity-100 shadow-[0_0_10px_rgba(61,191,251,0.6)]"
          style={{ top: `${(Math.abs(threshold) / 60) * 100}%` }} // Assumes 60dB is max range for visual
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 text-white z-30">
            {" "}
            {/* Higher Z-index */}
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
          disabled={
            isLoading || !clipBoundaries || clipBoundaries.duration <= 0
          }
          className="text-gray-400 hover:text-amber-50"
        >
          {isPlaying ? (
            <PauseIcon size={34} className="p-1.5" />
          ) : (
            <PlayIcon size={34} className="p-1.5" />
          )}
        </button>
        {!isLoading && clipBoundaries && clipBoundaries.duration > 0 && (
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
          </button>
        )}
        {!isLoading && clipBoundaries && clipBoundaries.duration > 0 && (
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
