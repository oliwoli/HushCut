import React, { useEffect, useState, useRef, useCallback } from "react"; // Added useCallback
import { Button } from "@/components/ui/button";
import deepEqual from "fast-deep-equal";
import { AudioWaveformIcon } from "lucide-react";

import { EventsOn } from "@wails/runtime/runtime";
import {
  MakeFinalTimeline,
  CalculateAndStoreEditsForTimeline,
  GetOrDetectSilencesWithCache,
} from "@wails/go/main/App";
import { main } from "@wails/go/models";
import type { DetectionParams, SilencePeriod } from "../types";

import { ClipStore, useClipStore, useGlobalStore } from '@/stores/clipStore';
import { useSyncBusyState } from "@/stores/appSync";
import { cn } from "./utils";


export function deriveAllClipDetectionParams(
  timelineItems: main.TimelineItem[],
  clipStoreState: ClipStore
): Record<string, DetectionParams> {
  const detectionParams: Record<string, DetectionParams> = {};

  for (const item of timelineItems) {
    const clipId = item.id;
    if (!clipId) continue;

    // It checks for clip-specific params, then falls back to live defaults.
    const correctClipParams = clipStoreState.parameters[clipId] ?? clipStoreState.liveDefaultParameters;

    // If a clip is bypassed, it should be excluded from processing.
    if (correctClipParams.bypassed) {
      continue;
    }

    detectionParams[clipId] = {
      loudnessThreshold: correctClipParams.threshold,
      minSilenceDurationSeconds: correctClipParams.minDuration,
      minContent: correctClipParams.minContent,
      paddingLeftSeconds: correctClipParams.paddingLeft,
      paddingRightSeconds: correctClipParams.paddingRight,
    };
  }
  return detectionParams;
}


interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  defaultDetectionParams: DetectionParams; // Renamed for clarity
  onPendingAction: () => void; // New prop for pending action
}

// Helper function
export async function prepareProjectDataWithEdits(
  projectDataInput: main.ProjectDataPayload,
  allClipParams: Record<string, DetectionParams>,
  keepSilenceSegments: boolean,
  defaultParams: DetectionParams
): Promise<main.ProjectDataPayload> {
  let workingProjectData: main.ProjectDataPayload = JSON.parse(
    JSON.stringify(projectDataInput)
  );

  if (
    !workingProjectData.timeline?.audio_track_items ||
    !workingProjectData.timeline.fps || // Ensure FPS is available
    workingProjectData.timeline.fps <= 0
  ) {
    console.warn(
      "prepareProjectDataWithEdits: No audio track items found, or missing/invalid timeline FPS."
    );
    return workingProjectData;
  }
  const timelineFps = workingProjectData.timeline.fps;

  console.log(
    "prepareProjectDataWithEdits: Starting fetching of silence detections per clip segment..."
  );

  const allClipSilencesMapForGo: Record<string, SilencePeriod[]> = {};

  const itemProcessingPromises =
    workingProjectData.timeline.audio_track_items.map(async (item) => {
      const clipId = item.id; // Ensure item.id is the correct key used in allClipParams

      // If a clip was bypassed, it will not be in `allClipParams`.
      // We must skip silence detection for it entirely.
      if (!clipId || !allClipParams.hasOwnProperty(clipId)) {
        if (clipId) {
          allClipSilencesMapForGo[clipId] = []; // Ensure an entry for Go, but with no edits.
        }
        return; // Skip this item.
      }

      if (
        !item.processed_file_name ||
        typeof item.source_start_frame !== "number" ||
        typeof item.source_end_frame !== "number"
      ) {
        console.warn(
          "Skipping item due to missing processed_file_name, id, or invalid frame numbers:",
          item.name,
          item.id
        );
        allClipSilencesMapForGo[clipId] = []; // Ensure an entry even if skipped
        return;
      }

      const itemSpecificParams = allClipParams[clipId] || defaultParams;
      const filePathForGo = item.processed_file_name;
      const clipStartSeconds = item.source_start_frame / timelineFps;
      const clipEndSeconds = item.source_end_frame / timelineFps;

      if (clipEndSeconds <= clipStartSeconds) {
        console.warn(
          `Skipping silence detection for item ${item.name
          } (${clipId}) due to invalid segment: start ${clipStartSeconds.toFixed(
            3
          )}s, end ${clipEndSeconds.toFixed(3)}s.`
        );
        allClipSilencesMapForGo[clipId] = [];
        return item;
      }

      try {
        // GetOrDetectSilencesWithCache returns SilencePeriod[] matching Go's struct (for JSON marshalling)
        const silencePeriodsForGo: SilencePeriod[] =
          await GetOrDetectSilencesWithCache(
            filePathForGo,
            itemSpecificParams.loudnessThreshold,
            itemSpecificParams.minSilenceDurationSeconds,
            itemSpecificParams.paddingLeftSeconds,
            itemSpecificParams.paddingRightSeconds,
            itemSpecificParams.minContent,
            clipStartSeconds,
            clipEndSeconds,
            timelineFps
          );
        allClipSilencesMapForGo[clipId] = silencePeriodsForGo;
      } catch (err) {
        console.error(
          `prepareProjectDataAndGetEdits: Failed to fetch silences for item ${item.name} (${clipId}):`,
          err
        );
        allClipSilencesMapForGo[clipId] = []; // Store empty array on error
      }
    });

  await Promise.all(itemProcessingPromises);

  console.log(
    "prepareProjectDataWithEdits: All per-clip segment silence detections processed."
  );

  console.log(
    "prepareProjectDataWithEdits: Calculating final edit instructions..."
  );
  const projectDataWithEdits = await CalculateAndStoreEditsForTimeline(
    workingProjectData,
    keepSilenceSegments,
    allClipSilencesMapForGo
  );
  console.log("prepareProjectDataWithEdits: Edit instructions calculated.", projectDataWithEdits);
  return projectDataWithEdits;
}

type ProcessedDataCache = {
  data: main.ProjectDataPayload;
  // The key represents all inputs used to generate the data
  key: {
    projectData: main.ProjectDataPayload;
    clipParams: Record<string, DetectionParams>;
    keepSilence: boolean;
  };
};

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const {
    projectData: initialProjectData,
    defaultDetectionParams,
    onPendingAction,
  } = props;

  const makeNewTimeline = useGlobalStore(s => s.makeNewTimeline);
  const keepSilence = useGlobalStore(s => s.keepSilence);
  const setBusy = useSyncBusyState(s => s.setBusy);

  // Single ref to manage the entire cache. No more duplicating Zustand state.
  const cacheRef = useRef<ProcessedDataCache | null>(null);

  // State for UI purposes only (button text, disabled status)
  const [isProcessingClick, setIsProcessingClick] = useState(false);
  const [isProcessingHover, setIsProcessingHover] = useState(false);

  // Invalidate the cache if the base project data prop changes.
  useEffect(() => {
    console.log("Invalidating processedData due to initialProjectData change.");
    cacheRef.current = null;
  }, [initialProjectData]);

  // useCallback is still useful, but its dependencies are simpler.
  const handleAction = useCallback(async (isClick: boolean) => {
    if (!initialProjectData) {
      console.error("Action: Initial project data is not available.");
      return;
    }

    // 1. Get current state of all inputs
    const clipStoreState = useClipStore.getState();
    const timelineItems = initialProjectData?.timeline?.audio_track_items ?? [];
    const currentClipParams = deriveAllClipDetectionParams(timelineItems, clipStoreState);

    // 2. Create the "key" for the current state
    const currentKey = {
      projectData: initialProjectData,
      clipParams: currentClipParams,
      keepSilence: keepSilence,
    };

    // 3. Check if the cache is valid by comparing keys
    if (cacheRef.current && deepEqual(cacheRef.current.key, currentKey)) {
      console.log(`Action (${isClick ? 'Click' : 'Hover'}): Using existing pre-processed data.`);
      // If it's a click, proceed to use the cached data. If it's just a hover, do nothing.
      if (isClick) {
        return cacheRef.current.data;
      }
      return; // Data is already cached, so hover action is complete.
    }

    // 4. If cache is invalid or doesn't exist, re-compute
    console.log(`Action (${isClick ? 'Click' : 'Hover'}): Stale or no cache. Preparing data...`);
    if (isClick) setIsProcessingClick(true);
    else setIsProcessingHover(true);

    try {
      const result = await prepareProjectDataWithEdits(
        initialProjectData,
        currentClipParams,
        keepSilence,
        defaultDetectionParams
      );

      // 5. Update the cache with the new data and the key that produced it
      cacheRef.current = { data: result, key: currentKey };
      console.log("Action: Cache updated.");
      return result;

    } catch (error) {
      console.error(`Action (${isClick ? 'Click' : 'Hover'}): Error during processing:`, error);
      // Invalidate cache on error to prevent using faulty data
      cacheRef.current = null;
      if (isClick) console.error(error);
    } finally {
      if (isClick) setIsProcessingClick(false);
      else setIsProcessingHover(false);
    }
  }, [initialProjectData, keepSilence, defaultDetectionParams]); // Dependencies are now simpler

  const handleMouseEnter = () => {
    if (isProcessingHover || isProcessingClick) return;
    handleAction(false);
  };

  const handleClick = async () => {
    if (isProcessingClick) return;
    const isBusy = useSyncBusyState.getState().isBusy;
    if (isBusy) {
      props.onPendingAction();
      console.log("App is busy, deferring Remove Silences action.");
      return;
    }
    setBusy(true);

    try {
      const dataToSend = await handleAction(true);

      if (dataToSend) {
        console.log("Click: Making final timeline...");
        const response = await MakeFinalTimeline(dataToSend, makeNewTimeline);
        if (response.alertIssued) {
          console.warn(
            "Sync operation resulted in an alert (issued by Go). Message:",
            response.message
          );
        }
        //else { console.log("eh") }
        //setBusy(false);
        if (!response || response.status === "error") {
          const errMessage = response?.message || "Unknown error occurred in timeline generation.";
          console.error("Click: Timeline generation failed:", errMessage);
          console.error(errMessage);
          setBusy(false);
          return;
        }
        console.log("Click: 'HushCut Silences' process finished successfully.");
      }
    } catch (error) {
      console.error("Click: Error during 'HushCut Silences' process:", error);
      const errorMessage = typeof error === "string" ? error : (error as Error).message || "An unknown error occurred.";
      console.error(errorMessage);
    } finally {
      setBusy(false);
    }
  };

  const buttonDisabled = isProcessingClick;
  const currentButtonText = isProcessingClick ? "Processing..." : (keepSilence ? "Cut to Silences" : "Remove Silences");

  return (
    <Button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      disabled={buttonDisabled}
      className={cn(`bg-stone-700/10 shadow-xl border-2 rounded-xl border-orange-400/60 hover:bg-gradient-to-b from-red-800/10 to-orange-800/20 text-white p-8 font-[200] ${buttonDisabled ? "opacity-50 cursor-not-allowed" : ""}`,
        "w-[12rem] md:w-3xs"
      )}
    >
      <span className="items-center align-middle flex text-base md:text-xl gap-4 font-[50]">
        <AudioWaveformIcon size={32} className="scale-125 md:scale-150 text-gray-500" />
        {currentButtonText}
      </span>
    </Button>
  );
};

export default RemoveSilencesButton;
