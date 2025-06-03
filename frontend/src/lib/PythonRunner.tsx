// src/components/PythonRunnerComponent.tsx
import React, { useEffect, useState, useRef, useCallback } from "react"; // Added useCallback
import { Button } from "@/components/ui/button";
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
  onScriptLog?: (line: string) => void;
  onScriptDone?: (message: string) => void;
  onScriptError?: (error: any) => void;
  buttonText?: string;
  keepSilenceSegments?: boolean;
  detectionParams: DetectionParams;
}

function areDetectionParamsEqual(
  params1: DetectionParams | null,
  params2: DetectionParams | null
): boolean {
  if (!params1 && !params2) return true; // Both null, considered equal
  if (!params1 || !params2) return false; // One is null, other isn't, not equal
  return (
    params1.loudnessThreshold === params2.loudnessThreshold &&
    params1.minSilenceDurationSeconds === params2.minSilenceDurationSeconds &&
    params1.paddingLeftSeconds === params2.paddingLeftSeconds &&
    params1.paddingRightSeconds === params2.paddingRightSeconds
    // Add checks for any other fields in DetectionParams if they exist
  );
}

// Helper function (as defined above)
// Helper function
async function prepareProjectDataWithEdits(
  projectDataInput: main.ProjectDataPayload,
  // For now, we still use the single detectionParams from props.
  // This will change when we implement per-clip params.
  detectionParams: DetectionParams,
  keepSilenceSegments: boolean
): Promise<main.ProjectDataPayload> {
  // Deep copy to avoid mutating the input
  let workingProjectData: main.ProjectDataPayload = JSON.parse(
    JSON.stringify(projectDataInput)
  );

  console.log(
    "prepareProjectDataWithEdits: Starting parallel fetching of silence detections..."
  );
  const uniqueSourceFiles = new Map<string, { processedFileName: string }>();

  workingProjectData.timeline?.audio_track_items?.forEach((item) => {
    if (item.source_file_path && item.processed_file_name) {
      uniqueSourceFiles.set(item.source_file_path, {
        processedFileName: item.processed_file_name,
      });
    }
  });
  // Add similar for video_track_items if they also use silence detection

  // Create an array of promises for fetching silence data for each file
  const silenceDetectionPromises = Array.from(uniqueSourceFiles.entries()).map(
    async ([filePath, fileInfo]) => {
      const fileDataInProject = workingProjectData.files[filePath]; // Note: this is from the copied workingProjectData
      if (!fileDataInProject) {
        console.warn(
          `prepareProjectDataWithEdits: File data not found for ${filePath} in working copy. Returning empty silences for this file.`
        );
        // Return a structure that allows associating filePath with empty/failed detection
        return {
          filePath,
          silenceDetections: [] as Array<main.SilenceInterval>,
        };
      }
      const cacheKey = fileInfo.processedFileName + ".wav";
      console.log(
        `prepareProjectDataWithEdits: - Queuing fetch for: ${cacheKey}`
      );
      try {
        const silencePeriods: SilencePeriod[] =
          await GetOrDetectSilencesWithCache(
            cacheKey,
            detectionParams.loudnessThreshold,
            detectionParams.minSilenceDurationSeconds,
            detectionParams.paddingLeftSeconds,
            detectionParams.paddingRightSeconds
          );

        // Convert to the structure expected by FileData.silenceDetections
        // Ensure this matches the type (main.SilenceInterval might have Start/End or start/end)
        const silenceIntervalsForFile: Array<main.SilenceInterval> =
          silencePeriods.map(
            (p) =>
              ({
                start: p.start, // these are in SECONDS
                end: p.end, // these are in SECONDS
              } as main.SilenceInterval)
          ); // Adjust casing if main.SilenceInterval has Start/End

        // console.log(`prepareProjectDataWithEdits: - Fetched for ${cacheKey}: ${silenceIntervalsForFile.length} periods`);
        return { filePath, silenceDetections: silenceIntervalsForFile };
      } catch (err) {
        console.error(
          `prepareProjectDataWithEdits: Failed to fetch silences for ${cacheKey}:`,
          err
        );
        // Return empty silences for this file on error to not break Promise.all
        return {
          filePath,
          silenceDetections: [] as Array<main.SilenceInterval>,
        };
      }
    }
  );

  // Wait for all silence detection promises to resolve
  const allSilenceResults = await Promise.all(silenceDetectionPromises);

  // Now, update workingProjectData with the results from all promises
  allSilenceResults.forEach((result) => {
    // Ensure file exists in the working copy before assigning
    if (workingProjectData.files[result.filePath]) {
      workingProjectData.files[result.filePath].silenceDetections =
        result.silenceDetections;
    } else {
      // This case should ideally not happen if uniqueSourceFiles was derived correctly from workingProjectData
      console.warn(
        `prepareProjectDataWithEdits: FilePath ${result.filePath} not found in workingProjectData.files after parallel fetch. This is unexpected.`
      );
    }
  });

  console.log(
    "prepareProjectDataWithEdits: All silence detections fetched (in parallel)."
  );

  console.log("prepareProjectDataWithEdits: Calculating edit instructions...");
  const projectDataWithEdits = await CalculateAndStoreEditsForTimeline(
    workingProjectData,
    keepSilenceSegments
  );
  console.log("prepareProjectDataWithEdits: Edit instructions calculated.");
  return projectDataWithEdits;
}

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const {
    projectData: initialProjectData,
    onScriptLog,
    onScriptDone,
    onScriptError,
    buttonText = "Prune Silences",
    keepSilenceSegments = false,
    detectionParams,
  } = props;

  const [processedData, setProcessedData] =
    useState<main.ProjectDataPayload | null>(null);
  const processedDataInputRef = useRef<main.ProjectDataPayload | null>(null);
  const [paramsForProcessedData, setParamsForProcessedData] =
    useState<DetectionParams | null>(null);

  const [isProcessingClick, setIsProcessingClick] = useState(false);
  const [isProcessingHover, setIsProcessingHover] = useState(false);
  const initialProjectDataRef = useRef(initialProjectData);

  useEffect(() => {
    initialProjectDataRef.current = initialProjectData;
    if (processedData) {
      const isInputDataStale =
        processedDataInputRef.current !== initialProjectData;
      const areParamsStale =
        paramsForProcessedData &&
        !areDetectionParamsEqual(detectionParams, paramsForProcessedData);

      if (isInputDataStale || areParamsStale) {
        if (isInputDataStale)
          console.log(
            "Invalidating processedData due to initialProjectData change."
          );
        if (areParamsStale)
          console.log(
            "Invalidating processedData due to detectionParams prop change."
          );

        setProcessedData(null);
        processedDataInputRef.current = null;
        setParamsForProcessedData(null);
      }
    }
  }, [
    initialProjectData,
    detectionParams,
    processedData,
    paramsForProcessedData,
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
    // Use current prop values directly for checks and operations
    const currentInitialData = initialProjectDataRef.current; // More reliable than initialProjectData prop directly in async
    const currentDetectionParams = detectionParams; // Current prop detectionParams

    if (isProcessingHover || !currentInitialData || isProcessingClick) {
      return;
    }

    // Staleness check:
    if (
      processedData &&
      processedDataInputRef.current === currentInitialData &&
      paramsForProcessedData &&
      areDetectionParamsEqual(currentDetectionParams, paramsForProcessedData)
    ) {
      console.log(
        "Hover: Data already processed for current input and params."
      );
      return;
    }

    setIsProcessingHover(true);
    console.log(
      "Hover: Starting silent pre-processing (data or params changed)..."
    );

    try {
      // Pass currentDetectionParams to the helper
      const result = await prepareProjectDataWithEdits(
        currentInitialData,
        currentDetectionParams, // Use the params active at the start of hover
        keepSilenceSegments
      );

      // Before setting state, verify that the inputs haven't changed *during* this async operation.
      // This ensures we don't apply a result calculated with stale inputs if props changed rapidly.
      if (
        initialProjectDataRef.current === currentInitialData &&
        areDetectionParamsEqual(detectionParams, currentDetectionParams) // Compare current prop `detectionParams` with those used for this run
      ) {
        setProcessedData(result);
        processedDataInputRef.current = currentInitialData; // The data it was based on
        setParamsForProcessedData(currentDetectionParams); // The params used for this result
        console.log("Hover: Silent pre-processing complete.");
      } else {
        console.log(
          "Hover: Input data or params changed during pre-processing; discarding result."
        );
      }
    } catch (error) {
      console.error("Hover: Error during silent pre-processing:", error);
    } finally {
      setIsProcessingHover(false);
    }
    // Ensure all relevant dependencies are included for useCallback
  }, [
    isProcessingHover,
    isProcessingClick,
    detectionParams, // Current prop
    keepSilenceSegments,
    initialProjectData, // Prop used for ref and for comparison post-async
    processedData,
    paramsForProcessedData,
  ]);

  const handleClick = async () => {
    if (isProcessingClick) {
      console.warn("Click: Processing already in progress.");
      return;
    }
    // Use current prop values directly
    const currentInitialData = initialProjectDataRef.current;
    const currentDetectionParams = detectionParams;

    if (!currentInitialData) {
      console.error("Click: Initial project data is not available.");
      if (onScriptError)
        onScriptError("Initial project data is not available.");
      return;
    }

    setIsProcessingClick(true);
    console.log("Click: Starting 'Prune Silences' process...");

    try {
      let dataToSend: main.ProjectDataPayload;

      // Staleness check for using existing processedData
      if (
        processedData &&
        processedDataInputRef.current === currentInitialData &&
        paramsForProcessedData &&
        areDetectionParamsEqual(currentDetectionParams, paramsForProcessedData)
      ) {
        console.log(
          "Click: Using existing pre-processed data (input and params match)."
        );
        dataToSend = processedData;
      } else {
        if (isProcessingHover) {
          console.log(
            "Click: Hover pre-processing is (or was recently) active. Will prepare data independently if needed."
          );
        }
        console.log(
          "Click: No fresh pre-processed data, params mismatch, or data stale. Preparing data now..."
        );
        dataToSend = await prepareProjectDataWithEdits(
          currentInitialData,
          currentDetectionParams, // Use current params for this run
          keepSilenceSegments
        );
        setProcessedData(dataToSend);
        processedDataInputRef.current = currentInitialData;
        setParamsForProcessedData(currentDetectionParams); // Store params used for this result
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
      className={`bg-teal-800 border-1 text-white p-8 hover:bg-teal-700 font-[400] ${
        buttonDisabled ? "opacity-50 cursor-not-allowed" : ""
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