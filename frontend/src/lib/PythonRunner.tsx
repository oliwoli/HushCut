import React, { useEffect, useState, useRef, useCallback } from "react"; // Added useCallback
import { Button } from "@/components/ui/button";
import deepEqual from "fast-deep-equal";
import { SliceIcon } from "lucide-react";

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


export function deriveAllClipDetectionParams(
  timelineItems: main.TimelineItem[], // <-- Pass in all timeline clips
  clipStoreState: ClipStore             // <-- Pass in the full store state
): Record<string, DetectionParams> {
  const detectionParams: Record<string, DetectionParams> = {};

  for (const item of timelineItems) {
    const clipId = item.id;
    if (!clipId) continue;

    // This is the correct logic, identical to our previous fix.
    // It checks for clip-specific params, then falls back to live defaults.
    const correctClipParams = clipStoreState.parameters[clipId] ?? clipStoreState.liveDefaultParameters;

    detectionParams[clipId] = {
      loudnessThreshold: correctClipParams.threshold,
      minSilenceDurationSeconds: correctClipParams.minDuration,
      minContentDuration: correctClipParams.minContent,
      paddingLeftSeconds: correctClipParams.paddingLeft,
      paddingRightSeconds: correctClipParams.paddingRight,
    };
  }
  return detectionParams;
}


interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  defaultDetectionParams: DetectionParams; // Renamed for clarity
  onScriptLog?: (line: string) => void;
  onScriptDone?: (message: string) => void;
  onScriptError?: (error: any) => void;
  keepSilenceSegments?: boolean;
}

// Helper function
async function prepareProjectDataWithEdits(
  projectDataInput: main.ProjectDataPayload,
  allClipParams: Record<string, DetectionParams>,
  keepSilenceSegments: boolean,
  defaultParams: DetectionParams
  // FPS is implicitly available in projectDataInput.timeline.fps
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

      if (
        !item.processed_file_name ||
        !clipId ||
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
            clipStartSeconds,
            clipEndSeconds
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

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const makeNewTimeline = useGlobalStore(s => s.makeNewTimeline);

  const {
    projectData: initialProjectData,
    defaultDetectionParams,
    onScriptLog,
    onScriptDone,
    onScriptError,
    keepSilenceSegments = false,
  } = props;


  const setBusy = useSyncBusyState(s => s.setBusy);

  const [processedData, setProcessedData] =
    useState<main.ProjectDataPayload | null>(null);
  const processedDataInputRef = useRef<main.ProjectDataPayload | null>(null);
  // This state will now store the map of params used for the `processedData`
  const [paramsMapForProcessedData, setParamsMapForProcessedData] =
    useState<Record<string, DetectionParams> | null>(null);

  const [isProcessingClick, setIsProcessingClick] = useState(false);
  const [isProcessingHover, setIsProcessingHover] = useState(false);

  const initialProjectDataRef = useRef(initialProjectData);
  const defaultParamsRef = useRef(defaultDetectionParams);


  useEffect(() => {
    initialProjectDataRef.current = initialProjectData;
    defaultParamsRef.current = defaultDetectionParams;
  }, [initialProjectData, defaultDetectionParams]);

  // REFACTOR: This useEffect is now MUCH simpler. It only invalidates the cache
  // if the main project data changes. Parameter changes will be handled
  // on-demand by the click/hover handlers.
  useEffect(() => {
    console.log("Invalidating processedData due to initialProjectData change.");
    setProcessedData(null);
    processedDataInputRef.current = null;
    setParamsMapForProcessedData(null);
  }, [initialProjectData]);

  useEffect(() => {
    const logHandler = (line: string) => {
      if (onScriptLog) onScriptLog(line);
    };
    const doneHandler = (message: string) => {
      if (onScriptDone) onScriptDone(message);
    };
    const unsubscribeLog = EventsOn(
      "python:log",
      logHandler as (data: unknown) => void
    );
    const unsubscribeDone = EventsOn(
      "python:done",
      doneHandler as (data: unknown) => void
    );
    return () => {
      unsubscribeLog();
      unsubscribeDone();
    };
  }, [onScriptLog, onScriptDone]);

  const handleMouseEnter = useCallback(async () => {
    const clipStoreState = useClipStore.getState();
    const timelineItems = initialProjectDataRef.current?.timeline?.audio_track_items ?? [];
    const currentAllClipParams = deriveAllClipDetectionParams(timelineItems, clipStoreState);

    // Use refs for props that might change, to avoid stale closures.
    const currentInitialData = initialProjectDataRef.current;
    const currentDefaultParams = defaultParamsRef.current;

    if (isProcessingHover || !currentInitialData || isProcessingClick) {
      return;
    }

    if (
      processedData &&
      processedDataInputRef.current === currentInitialData &&
      // Use deepEqual for comparing the map of params
      deepEqual(currentAllClipParams, paramsMapForProcessedData)
    ) {
      console.log(
        "Hover: Data already processed for current input and params map."
      );
      return;
    }

    setIsProcessingHover(true);
    console.log(
      "Hover: Starting silent pre-processing (data or params map changed)..."
    );

    try {
      const result = await prepareProjectDataWithEdits(
        currentInitialData,
        currentAllClipParams,
        keepSilenceSegments,
        currentDefaultParams // This prop can now be removed
      );

      const finalClipStoreState = useClipStore.getState();
      const finalTimelineItems = initialProjectDataRef.current?.timeline?.audio_track_items ?? [];
      const finalAllClipParams = deriveAllClipDetectionParams(finalTimelineItems, finalClipStoreState);

      if (
        initialProjectDataRef.current === currentInitialData &&
        deepEqual(finalAllClipParams, currentAllClipParams)
      ) {
        setProcessedData(result);
        processedDataInputRef.current = currentInitialData;
        setParamsMapForProcessedData(currentAllClipParams);
      }
    } catch (error) {
      console.error("Hover: Error during silent pre-processing:", error);
    } finally {
      setIsProcessingHover(false);
    }
    // REFACTOR: The dependency array for useCallback is now simpler.
  }, [
    isProcessingHover,
    isProcessingClick,
    keepSilenceSegments,
    processedData,
    paramsMapForProcessedData,
  ]);

  const handleClick = async () => {
    if (isProcessingClick) {
      console.warn("Click: Processing already in progress.");
      return;
    }
    setBusy(true);
    const clipStoreState = useClipStore.getState();
    const timelineItems = initialProjectDataRef.current?.timeline?.audio_track_items ?? [];

    // Call the corrected helper function to get params for ALL clips
    const currentAllClipParams = deriveAllClipDetectionParams(timelineItems, clipStoreState);

    const currentInitialData = initialProjectDataRef.current;
    const currentDefaultParams = defaultParamsRef.current;

    if (!currentInitialData) {
      console.error("Click: Initial project data is not available.");
      if (onScriptError)
        onScriptError("Initial project data is not available.");
      return;
    }
    if (
      !currentInitialData?.timeline?.fps ||
      currentInitialData.timeline.fps <= 0
    ) {
      console.error(
        "Cannot process: Missing or invalid timeline FPS from project data."
      );
      if (onScriptError) onScriptError("Missing or invalid timeline FPS.");
      return;
    }

    setIsProcessingClick(true);
    console.log("Click: Starting 'HushCut Silences' process...");

    try {
      let dataToSend: main.ProjectDataPayload;

      if (
        processedData &&
        processedDataInputRef.current === currentInitialData &&
        // Use deepEqual for comparing the map of params
        deepEqual(currentAllClipParams, paramsMapForProcessedData)
      ) {
        console.log(
          "Click: Using existing pre-processed data (input and params map match)."
        );
        dataToSend = processedData;
      } else {
        // console.log("Click: No fresh pre-processed data or params map mismatch/stale. Preparing data now...");
        dataToSend = await prepareProjectDataWithEdits(
          currentInitialData,
          currentAllClipParams,
          keepSilenceSegments,
          currentDefaultParams
        );
        setProcessedData(dataToSend);
        processedDataInputRef.current = currentInitialData;
        setParamsMapForProcessedData(currentAllClipParams); // Store the map that was used
      }

      console.log("Click: Making final timeline...");
      const response = await MakeFinalTimeline(dataToSend, makeNewTimeline);

      if (!response || response.status === "error") {
        const errMessage =
          response?.message || "Unknown error occurred in timeline generation.";
        console.error("Click: Timeline generation failed:", errMessage);
        if (onScriptError) onScriptError(errMessage);
        return;
      }

      if (response.alertIssued) {
        console.warn(
          "Sync operation resulted in an alert (issued by Go). Message:",
          response.message
        );
      }
      //else { console.log("eh") }
      setBusy(false);

      console.log("Click: 'HushCut Silences' process finished successfully.");
      if (onScriptDone)
        onScriptDone("'HushCut Silences' process completed successfully.");
    } catch (error: any) {
      console.error("Click: Error during 'HushCut Silences' process:", error);
      const errorMessage =
        typeof error === "string"
          ? error
          : error.message || "An unknown error occurred.";
      if (onScriptError) onScriptError(errorMessage);
    } finally {
      setIsProcessingClick(false);
    }
  };

  const buttonDisabled = isProcessingClick;
  const currentButtonText = isProcessingClick ? "Processing..." : "Remove Silences";

  return (
    <Button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      disabled={buttonDisabled}
      className={`bg-teal-800 border-1 text-white p-8 hover:bg-teal-700 font-[400] ${buttonDisabled ? "opacity-50 cursor-not-allowed" : ""
        }`}
    >
      <span className="items-center align-middle flex text-xl gap-4">
        <SliceIcon size={32} className="scale-150 text-teal-500" />
        {currentButtonText}
      </span>
    </Button>
  );
};

export default RemoveSilencesButton;
