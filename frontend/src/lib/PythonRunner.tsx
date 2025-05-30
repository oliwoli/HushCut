// src/components/PythonRunnerComponent.tsx
import React, { useEffect, useCallback } from 'react';
import { RunPythonScriptWithArgs } from "@wails/go/main/App";
import { EventsOn } from "@wails/runtime/runtime";
import { Button } from '@/components/ui/button';
import { SliceIcon, StethoscopeIcon } from 'lucide-react';

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
const RemoveSilencesButton: React.FC<PythonRunnerProps> = (props) => {
    const {
        threshold,
        minDuration,
        padLeft,
        padRight,
        makeNewTimeline,
        onScriptLog,
        onScriptDone,
        onScriptError,
        buttonText = "Remove Silences" // Default value if not provided
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
        <Button onClick={handleRunScript} className='bg-teal-800 border-1 text-white p-8 hover:bg-teal-700'>
            <span className='items-center align-middle flex text-xl gap-4'>
                <SliceIcon size={32} className='scale-150 text-teal-500' />{buttonText}</span>
        </Button>
    );
};



export default RemoveSilencesButton;