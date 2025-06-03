// src/components/PythonRunnerComponent.tsx
import React, { useEffect, useCallback, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { SliceIcon } from "lucide-react";

import { EventsOn } from "@wails/runtime/runtime";
// Import the new Go function and the existing one
import {
  MakeFinalTimeline,
  CalculateAndStoreEditsForTimeline,
} from "@wails/go/main/App";
import { main } from "@wails/go/models";

interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  onScriptLog?: (line: string) => void;
  onScriptDone?: (message: string) => void;
  onScriptError?: (error: any) => void;
  buttonText?: string;
  keepSilenceSegments?: boolean; // true to keep silences (disabled), false to remove them
}

const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
  const {
    projectData: initialProjectData,
    onScriptLog,
    onScriptDone,
    onScriptError,
    buttonText = "Prune Silences", // Default implies removing silences
    keepSilenceSegments = true, // Default to false (remove silences)
  } = props;

  const [processedProjectData, setProcessedProjectData] =
    useState<main.ProjectDataPayload | null>(null);
  const [isCalculatingEdits, setIsCalculatingEdits] = useState(false);
  const initialProjectDataRef = useRef(initialProjectData);

  // Update ref and reset processed data if initialProjectData prop changes
  useEffect(() => {
    initialProjectDataRef.current = initialProjectData;
    setProcessedProjectData(initialProjectData); // Reset to trigger re-calc on hover for new data
  }, [initialProjectData]);

  // Wails event listeners for Python script logs/status
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

  // Calculate edit instructions on hover
  const handleMouseEnter = useCallback(async () => {
    if (!initialProjectDataRef.current || isCalculatingEdits) {
      return;
    }
    // Check if edits for the current data are already processed to avoid redundant calls
    // This simple check assumes if processedProjectData is not the initial one, it's processed.
    // A more detailed check could inspect for actual EditInstructions.
    if (
      processedProjectData &&
      processedProjectData !== initialProjectDataRef.current
    ) {
      // console.log("Edit instructions likely already calculated for current data set.");
      // return;
      // Allow re-hover to re-calculate if needed, e.g., if keepSilenceSegments changed.
      // Or, for simplicity, we can always re-calculate on hover for now.
    }

    console.log("Button hovered, calculating edit instructions...");
    setIsCalculatingEdits(true);
    try {
      const updatedProjectData = await CalculateAndStoreEditsForTimeline(
        initialProjectDataRef.current,
        keepSilenceSegments
      );
      setProcessedProjectData(updatedProjectData);
      console.log(
        "Edit instructions calculated and stored in component state."
      );
    } catch (error) {
      console.error("Error calculating edit instructions:", error);
      if (onScriptError) onScriptError(error);
      setProcessedProjectData(initialProjectDataRef.current); // Revert to initial on error
    } finally {
      setIsCalculatingEdits(false);
    }
  }, [
    keepSilenceSegments,
    onScriptError,
    isCalculatingEdits,
    processedProjectData,
  ]); // Added processedProjectData

  // Handle button click to send data to Python
  const handleClick = async () => {
    if (isCalculatingEdits) {
      console.warn("Edit calculation in progress, please wait.");
      return;
    }

    let dataToSend = processedProjectData || initialProjectDataRef.current;

    if (!dataToSend) {
      console.error("No project data available to send.");
      if (onScriptError) onScriptError("No project data available.");
      return;
    }

    // If processedProjectData is still the initial one (or null),
    // it means hover might not have completed or was skipped.
    // Force calculation if necessary.
    const isDataProcessed =
      processedProjectData &&
      processedProjectData !== initialProjectDataRef.current;

    if (!isDataProcessed && initialProjectDataRef.current) {
      console.log(
        "Forcing edit calculation on click as it might have been missed or data is stale."
      );
      setIsCalculatingEdits(true);
      try {
        const finalData = await CalculateAndStoreEditsForTimeline(
          initialProjectDataRef.current,
          keepSilenceSegments
        );
        setProcessedProjectData(finalData);
        dataToSend = finalData; // Use the freshly calculated data
        console.log("Sending data with freshly calculated edits after click.");
      } catch (error) {
        console.error("Error calculating edits on click:", error);
        if (onScriptError) onScriptError(error);
        // Fallback to sending initial data if calculation fails on click
        dataToSend = initialProjectDataRef.current;
      } finally {
        setIsCalculatingEdits(false);
      }
    }

    console.log("Sending project data to MakeFinalTimeline:", dataToSend);
    try {
      await MakeFinalTimeline(dataToSend);
    } catch (error) {
      console.error("Error calling MakeFinalTimeline:", error);
      if (onScriptError) onScriptError(error);
    }
  };

  const buttonDisabled = isCalculatingEdits;
  const currentButtonText = isCalculatingEdits ? "Processing..." : buttonText;

  return (
    <Button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
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