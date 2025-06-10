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

interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  allClipDetectionParams: Record<string, DetectionParams>; // Renamed for clarity in this component
  defaultDetectionParams: DetectionParams; // Renamed for clarity
  onScriptLog?: (line: string) => void;
  onScriptDone?: (message: string) => void;
  onScriptError?: (error: any) => void;
  buttonText?: string;
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
      const filePathForGo = item.processed_file_name + ".wav";
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

      // console.log(
      //   `prepareProjectDataWithEdits: - Queuing fetch for item ${item.name} (${clipId}), file: ${filePathForGo}, ` +
      //   `segment: ${clipStartSeconds.toFixed(3)}s to ${clipEndSeconds.toFixed(3)}s. Params: `, itemSpecificParams
      // );

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
  console.log("prepareProjectDataWithEdits: Edit instructions calculated.");
  return projectDataWithEdits;
}

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const {
    projectData: initialProjectData,
    allClipDetectionParams,
    defaultDetectionParams,
    onScriptLog,
    onScriptDone,
    onScriptError,
    buttonText = "Prune Silences",
    keepSilenceSegments = false,
  } = props;

  const [processedData, setProcessedData] =
    useState<main.ProjectDataPayload | null>(null);
  const processedDataInputRef = useRef<main.ProjectDataPayload | null>(null);
  // This state will now store the map of params used for the `processedData`
  const [paramsMapForProcessedData, setParamsMapForProcessedData] =
    useState<Record<string, DetectionParams> | null>(null);

  const [isProcessingClick, setIsProcessingClick] = useState(false);
  const [isProcessingHover, setIsProcessingHover] = useState(false);

  const initialProjectDataRef = useRef(initialProjectData);
  const allClipParamsRef = useRef(allClipDetectionParams);
  const defaultParamsRef = useRef(defaultDetectionParams);

  useEffect(() => {
    initialProjectDataRef.current = initialProjectData;
    allClipParamsRef.current = allClipDetectionParams;
    defaultParamsRef.current = defaultDetectionParams;

    if (processedData) {
      const isInputDataStale =
        processedDataInputRef.current !== initialProjectData;
      // Use deepEqual for comparing the entire map of parameters
      const areParamsStale = !deepEqual(
        allClipDetectionParams,
        paramsMapForProcessedData
      );

      if (isInputDataStale || areParamsStale) {
        if (isInputDataStale)
          console.log(
            "Invalidating processedData due to initialProjectData change."
          );
        if (areParamsStale)
          console.log(
            "Invalidating processedData due to allClipDetectionParams change."
          );

        setProcessedData(null);
        processedDataInputRef.current = null;
        setParamsMapForProcessedData(null); // Reset the stored params map
      }
    }
  }, [
    initialProjectData,
    allClipDetectionParams,
    processedData,
    paramsMapForProcessedData,
  ]);

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
    const currentInitialData = initialProjectDataRef.current;
    const currentAllClipParams = allClipParamsRef.current; // Use ref
    const currentDefaultParams = defaultParamsRef.current; // Use ref

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
        currentDefaultParams
      );

      // Check if props have changed *during* the async operation
      if (
        initialProjectDataRef.current === currentInitialData &&
        deepEqual(allClipParamsRef.current, currentAllClipParams)
      ) {
        setProcessedData(result);
        processedDataInputRef.current = currentInitialData;
        setParamsMapForProcessedData(currentAllClipParams); // Store the map that was used
        // console.log("Hover: Silent pre-processing complete.");
      } else {
        // console.log("Hover: Input data or params map changed during pre-processing; discarding result.");
      }
    } catch (error) {
      console.error("Hover: Error during silent pre-processing:", error);
    } finally {
      setIsProcessingHover(false);
    }
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
    const currentInitialData = initialProjectDataRef.current;
    const currentAllClipParams = allClipParamsRef.current; // Use ref
    const currentDefaultParams = defaultParamsRef.current; // Use ref

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
    console.log("Click: Starting 'Prune Silences' process...");

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
      await MakeFinalTimeline(dataToSend);
      console.log("Click: 'Prune Silences' process finished successfully.");
      if (onScriptDone)
        onScriptDone("'Prune Silences' process completed successfully.");
    } catch (error: any) {
      console.error("Click: Error during 'Prune Silences' process:", error);
      const errorMessage =
        typeof error === "string"
          ? error
          : error.message || "An unknown error occurred.";
      if (onScriptError) onScriptError(errorMessage);
    } finally {
      setIsProcessingClick(false);
    }
  };

  const buttonDisabled = isProcessingClick; // Only click processing disables the button visibly
  const currentButtonText = isProcessingClick ? "Processing..." : buttonText; // Only click processing changes text

  return (
    <Button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter} // Re-added onMouseEnter
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