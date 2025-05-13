// src/components/PythonRunnerComponent.tsx
import React, { useEffect, useCallback } from 'react';
// Adjust the import paths if your wailsjs directory is structured differently or elsewhere
import { RunPythonScriptWithArgs } from "../../wailsjs/go/main/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { Button } from '@/components/ui/button';

// 1. Define an interface for the component's props
interface PythonRunnerProps {
    threshold: number;
    minDuration: number;
    padLeft: number;
    padRight: number;
    makeNewTimeline: boolean;
    onScriptLog?: (line: string) => void;       // Optional callback
    onScriptDone?: (message: string) => void;    // Optional callback
    onScriptError?: (error: any) => void;        // Optional callback
    buttonText?: string;                         // Optional button text
}

// 2. Use the interface to type the props
const PythonRunnerComponent: React.FC<PythonRunnerProps> = (props) => {
    // Destructure props for easier access (TypeScript will infer their types from PythonRunnerProps)
    const {
        threshold,
        minDuration,
        padLeft,
        padRight,
        makeNewTimeline,
        onScriptLog,
        onScriptDone,
        onScriptError,
        buttonText = "Run Python Script" // Default value if not provided
    } = props;

    useEffect(() => {
        console.log("PythonRunnerComponent: Setting up Wails event listeners...");

        const logHandler = (line: string) => { // Explicitly type 'line' if needed, though inferred
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

        // It's good practice to ensure EventsOn passes string as you expect,
        // or add type checks/assertions if the data could be different.
        const unsubscribeLog = EventsOn("python:log", logHandler as (data: unknown) => void);
        const unsubscribeDone = EventsOn("python:done", doneHandler as (data: unknown) => void);


        return () => {
            console.log("PythonRunnerComponent: Cleaning up Wails event listeners...");
            unsubscribeLog();
            unsubscribeDone();
        };
    }, [onScriptLog, onScriptDone]); // Dependencies for useEffect

    const handleRunScript = useCallback(() => {
        console.log("PythonRunnerComponent: Initiating Python script with props:", {
            threshold, minDuration, padLeft, padRight, makeNewTimeline
        });
        const scriptArgs: string[] = [
            `--threshold=${threshold}`,
            `--min-duration=${minDuration}`,
            `--pad-left=${padLeft}`,
            `--pad-right=${padRight}`,
            makeNewTimeline ? "--new-timeline" : "",
        ].filter((arg): arg is string => Boolean(arg)); // Use a type predicate for filtering

        RunPythonScriptWithArgs(scriptArgs)
            .then(() => {
                console.log("PythonRunnerComponent: Go function RunPythonScriptWithArgs called successfully.");
            })
            .catch(error => {
                console.error("PythonRunnerComponent: Error calling Go function RunPythonScriptWithArgs:", error);
                if (onScriptError) {
                    onScriptError(error);
                }
            });
    }, [threshold, minDuration, padLeft, padRight, makeNewTimeline, onScriptError]); // Dependencies for useCallback


    return (
        <Button onClick={handleRunScript}>
            {buttonText}
        </Button>
    );
};

// You can still define defaultProps separately if you prefer,
// though default values in destructuring is also common.
// PythonRunnerComponent.defaultProps = {
//   buttonText: "Run Python Script",
//   // onScriptLog: () => {}, // etc. for optional functions if needed
// };

export default PythonRunnerComponent;