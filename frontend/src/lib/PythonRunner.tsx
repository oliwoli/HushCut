// src/components/PythonRunnerComponent.tsx
import React, { useEffect, useCallback } from "react";
import { Button } from '@/components/ui/button';
import { SliceIcon } from "lucide-react";

import { EventsOn } from "@wails/runtime/runtime";
import { RunPythonScriptWithArgs } from "@wails/go/main/App";
import { MakeFinalTimeline } from "@wails/go/main/App";
import { main } from "@wails/go/models";
// 1. Define an interface for the component's props
interface PythonRunnerProps {
  projectData: main.ProjectDataPayload;
  onScriptLog?: (line: string) => void; // Optional callback
  onScriptDone?: (message: string) => void; // Optional callback
  onScriptError?: (error: any) => void; // Optional callback
  buttonText?: string; // Optional button text
}

// 2. Use the interface to type the props
const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
    const {
      projectData,
      onScriptLog,
      onScriptDone,
      onScriptError,
      buttonText = "Remove Silences", // Default value if not provided
    } = props;

    useEffect(() => {
        console.log("PythonRunnerComponent: Setting up Wails event listeners...");

        const logHandler = (line: string) => {
            console.log("[Python STDOUT/STDERR]:", line);
            if (onScriptLog) {
                onScriptLog(line);
            }
        };

        const doneHandler = (message: string) => { // Explicitly type 'message'
            console.log("[Python Status]:", message);
            if (onScriptDone) {
                onScriptDone(message);
            }
        };

        const unsubscribeLog = EventsOn("python:log", logHandler as (data: unknown) => void);
        const unsubscribeDone = EventsOn("python:done", doneHandler as (data: unknown) => void);

        return () => {
            console.log("PythonRunnerComponent: Cleaning up Wails event listeners...");
            unsubscribeLog();
            unsubscribeDone();
        };
    }, [onScriptLog, onScriptDone]); // Dependencies for useEffect

    return (
      <Button
        onClick={() => MakeFinalTimeline(projectData)}
        className="bg-teal-800 border-1 text-white p-8 hover:bg-teal-700"
      >
        <span className="items-center align-middle flex text-xl gap-4">
          <SliceIcon size={32} className="scale-150 text-teal-500" />
          {buttonText}
        </span>
      </Button>
    );
};



export default RemoveSilencesButton;