import React, { useEffect, useState, useRef, useCallback } from "react"; // Added useCallback
import { Button } from "@/components/ui/button";
import deepEqual from "fast-deep-equal";
import { AudioWaveformIcon } from "lucide-react";

import {
  MakeFinalTimeline,
  CalculateAndStoreEditsForTimeline,
  GetOrDetectSilencesWithCache,
} from "@wails/go/main/App";
import { main } from "@wails/go/models";
import type { DetectionParams, RegionModification, SilencePeriod } from "../types";

import { ClipStore, useClipStore, useGlobalStore } from '@/stores/clipStore';
import { useAppState } from "@/stores/appSync";
import { cn } from "./utils";


import {
  deriveAllClipDetectionParams,
  intersectMultipleSilenceLists,
  postProcessSilencesWithModifications,
} from "./clipUtils";
export { deriveAllClipDetectionParams };

// Helper function
export async function prepareProjectDataWithEdits(
  projectDataInput: main.ProjectDataPayload,
  allClipParams: Record<string, DetectionParams>,
  keepSilenceSegments: boolean,
  defaultParams: DetectionParams,
  regionModificationsInput?: Record<string, RegionModification[]>
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
  const clipStoreState = useClipStore.getState();
  const regionModifications =
    regionModificationsInput ?? clipStoreState.regionModifications ?? {};

  console.log(
    "prepareProjectDataWithEdits: Starting fetching of silence detections per clip segment..."
  );

  const allClipSilencesMapForGo: Record<string, SilencePeriod[]> = {};
  const rawSilencesByClipId: Record<string, Array<{ start: number; end: number }>> = {};

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
        const rawSilences = await GetOrDetectSilencesWithCache(
          filePathForGo,
          itemSpecificParams.loudnessThreshold,
          0.009,
          0,
          0,
          0,
          clipStartSeconds,
          clipEndSeconds,
          timelineFps
        );
        rawSilencesByClipId[clipId] = rawSilences;
        const silencePeriodsForGo: SilencePeriod[] =
          postProcessSilencesWithModifications(
            rawSilences,
            itemSpecificParams,
            clipStartSeconds,
            clipEndSeconds,
            regionModifications[clipId]
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

  // Apply group-level regionModifications (from Combined Overview) for linked groups if present
  const groupItemsMap = new Map<number, main.TimelineItem[]>();
  for (const item of workingProjectData.timeline.audio_track_items) {
    if (item.link_group_id != null) {
      const list = groupItemsMap.get(item.link_group_id) ?? [];
      list.push(item);
      groupItemsMap.set(item.link_group_id, list);
    }
  }

  for (const [gid, groupItems] of groupItemsMap.entries()) {
    if (groupItems.length < 2) continue;
    const groupId = `linkgroup_${gid}`;
    const groupMods = regionModifications[groupId];
    if (!groupMods || groupMods.length === 0) continue;

    const activeGroupItems = groupItems.filter(
      (it) => it.id && allClipParams.hasOwnProperty(it.id)
    );
    if (activeGroupItems.length === 0) continue;

    let minStartFrame = groupItems[0].start_frame;
    let maxEndFrame = groupItems[0].end_frame;
    for (const it of groupItems) {
      if (it.start_frame < minStartFrame) minStartFrame = it.start_frame;
      if (it.end_frame > maxEndFrame) maxEndFrame = it.end_frame;
    }
    const groupDurationSeconds = (maxEndFrame - minStartFrame) / timelineFps;
    if (groupDurationSeconds <= 0) continue;

    const gp: DetectionParams = {
      loudnessThreshold: clipStoreState.getParameter(groupId, "threshold"),
      minSilenceDurationSeconds: clipStoreState.getParameter(groupId, "minDuration"),
      paddingLeftSeconds: clipStoreState.getParameter(groupId, "paddingLeft"),
      paddingRightSeconds: clipStoreState.getParameter(groupId, "paddingRight"),
      minContent: clipStoreState.getParameter(groupId, "minContent"),
    };

    const constituentLists: SilencePeriod[][] = [];
    for (const it of activeGroupItems) {
      const raw = rawSilencesByClipId[it.id] ?? [];
      const cp = allClipParams[it.id] || defaultParams;
      const clipStartSeconds = it.source_start_frame / timelineFps;
      const clipEndSeconds = it.source_end_frame / timelineFps;
      const offsetSeconds = (it.start_frame - minStartFrame) / timelineFps;
      const shift = -clipStartSeconds + offsetSeconds;

      const effectiveParams = {
        minSilenceDurationSeconds: Math.max(
          0.009,
          cp.minSilenceDurationSeconds - gp.minSilenceDurationSeconds
        ),
        paddingLeftSeconds: Math.max(
          0,
          cp.paddingLeftSeconds - gp.paddingLeftSeconds
        ),
        paddingRightSeconds: Math.max(
          0,
          cp.paddingRightSeconds - gp.paddingRightSeconds
        ),
        minContent: Math.max(0, cp.minContent - gp.minContent),
      };

      const processed = postProcessSilencesWithModifications(
        raw,
        effectiveParams,
        clipStartSeconds,
        clipEndSeconds,
        regionModifications[it.id]
      );

      const mapped: SilencePeriod[] = [];
      for (const s of processed) {
        const clampedStart = Math.max(0, s.start + shift);
        const clampedEnd = Math.min(groupDurationSeconds, s.end + shift);
        if (clampedEnd > clampedStart + 1e-4) {
          mapped.push({ start: clampedStart, end: clampedEnd });
        }
      }
      constituentLists.push(mapped);
    }

    const intersectedRaw = intersectMultipleSilenceLists(constituentLists);
    const groupSilences = postProcessSilencesWithModifications(
      intersectedRaw,
      gp,
      0,
      groupDurationSeconds,
      groupMods
    );

    // Map group silences back into each active constituent item's source time domain
    for (const it of activeGroupItems) {
      const clipStartSeconds = it.source_start_frame / timelineFps;
      const clipEndSeconds = it.source_end_frame / timelineFps;
      const offsetSeconds = (it.start_frame - minStartFrame) / timelineFps;
      const itemSilences: SilencePeriod[] = [];
      for (const gs of groupSilences) {
        const srcStart = Math.max(clipStartSeconds, gs.start - offsetSeconds + clipStartSeconds);
        const srcEnd = Math.min(clipEndSeconds, gs.end - offsetSeconds + clipStartSeconds);
        if (srcEnd > srcStart + 1e-4) {
          itemSilences.push({ start: srcStart, end: srcEnd });
        }
      }
      allClipSilencesMapForGo[it.id] = itemSilences;
    }
  }

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
    regionModifications: Record<string, RegionModification[]>;
    keepSilence: boolean;
  };
};

interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  defaultDetectionParams: DetectionParams;
  onPendingAction: () => void;
}

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const {
    projectData: initialProjectData,
    defaultDetectionParams,
    onPendingAction,
  } = props;

  const makeNewTimeline = useGlobalStore(s => s.makeNewTimeline);
  const keepSilence = useGlobalStore(s => s.keepSilence);
  const setBusy = useAppState(s => s.setBusy);

  const setSyncPaused = useAppState((s) => s.setSyncPaused);
  const isBusy = useAppState.getState().isBusy;

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

  const handleAction = useCallback(async (isClick: boolean) => {
    if (!initialProjectData) {
      console.error("Action: Initial project data is not available.");
      return;
    }

    // Get current state of all inputs
    const clipStoreState = useClipStore.getState();
    const timelineItems = initialProjectData?.timeline?.audio_track_items ?? [];
    const currentClipParams = deriveAllClipDetectionParams(timelineItems, clipStoreState);

    const currentKey = {
      projectData: initialProjectData,
      clipParams: currentClipParams,
      regionModifications: clipStoreState.regionModifications,
      keepSilence: keepSilence,
    };

    // Check if the cache is valid by comparing keys
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
        defaultDetectionParams,
        clipStoreState.regionModifications
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
  }, [initialProjectData, keepSilence, defaultDetectionParams]);

  const handleMouseEnter = () => {
    if (isProcessingHover || isProcessingClick) return;
    handleAction(false);
  };

  const handleClick = async () => {
    if (isProcessingClick) return;
    if (isBusy) {
      onPendingAction();
      console.log("App is busy, deferring Remove Silences action.");
      return;
    }
    setBusy(true);
    setSyncPaused(true);
    try {
      const dataToSend = await handleAction(true);

      if (dataToSend) {
        console.log("Click: Making final timeline...");
        const response = await MakeFinalTimeline(dataToSend, makeNewTimeline);
        if (response?.alertIssued) {
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
      className={
        cn(
          "bg-stone-700/10 shadow-xl border-2 rounded-xl border-orange-400/60 hover:bg-gradient-to-b from-red-800/10 to-orange-800/20 text-white p-8 font-extralight",
          `${buttonDisabled ? "opacity-50 cursor-not-allowed" : ""}`,
          "w-42 md:w-3xs sm:w-48"
        )}
    >
      <span className="items-center font-label align-middle flex text-base md:text-[1.45rem] tracking-normal gap-4 font-light">
        <AudioWaveformIcon size={32} className="scale-125 md:scale-150 text-gray-500" />
        {currentButtonText}
      </span>
    </Button>
  );
};

export default RemoveSilencesButton;
