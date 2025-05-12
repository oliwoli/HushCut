import React, { useRef, useEffect, useState } from "react";
// Ensure you import all necessary types from peaks.js
import Peaks, {
    JsonWaveformData, // The actual data structure type
    PeaksInstance,
    PeaksOptions,
    Segment,
} from "peaks.js";
import "./WaveformPlayer.css";

// Declare the window interface for the global AudioContext hack
declare global {
    interface Window {
        _peaksAudioContext?: AudioContext;
    }
}

interface WaveformPlayerProps {
    audioUrl: string;
    waveformDataUrl: string; // URL to the .json data file
}

// Place this function outside the component or inside using useCallback if needed
const normalizeWaveformData = (inputData: JsonWaveformData | null): JsonWaveformData | null => {
    if (!inputData) {
        console.log("Normalization skipped: No input data.");
        return null;
    }

    const data = inputData.data;
    if (!data || data.length === 0) {
        console.log("Normalization skipped: No data points in input.");
        return inputData; // Return original if no data points
    }

    console.log(`Normalizing data with ${data.length} points, bits: ${inputData.bits}`);

    // Find the maximum absolute value in the original data
    let globalMaxAbs = 0;
    for (let i = 0; i < data.length; i++) {
        const absValue = Math.abs(data[i]);
        if (absValue > globalMaxAbs) {
            globalMaxAbs = absValue;
        }
    }
    console.log(`Normalization: Found global absolute max: ${globalMaxAbs}`);


    // If the maximum is 0 (silence), no scaling is needed
    if (globalMaxAbs === 0) {
        console.log("Normalization skipped: Global max is 0 (silence).");
        return inputData;
    }

    // Determine the target peak value based on the bit depth
    const bits = inputData.bits === 8 ? 8 : 16; // Default to 16 if not 8
    const targetPeak = bits === 8 ? 127 : 32767;
    const minPeak = bits === 8 ? -128 : -32768;

    // Calculate the scaling factor
    const scalingFactor = targetPeak / globalMaxAbs;
    console.log(`Normalization: Scaling factor: ${scalingFactor} (targetPeak: ${targetPeak})`);


    // Create a new array with normalized and clamped values
    const normalizedData = data.map(value => {
        // Scale the value
        const scaledValue = Math.round(value * scalingFactor);
        // Clamp the value to the valid range for the bit depth
        return Math.max(minPeak, Math.min(targetPeak, scaledValue));
    });

    // Return a *new* waveform data object with the normalized data array
    // and the original metadata (version, channels, sample_rate, etc.)
    return {
        ...inputData, // Copy metadata like version, sample_rate etc.
        data: normalizedData,
    };
};


const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
    audioUrl,
    waveformDataUrl,
}) => {
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    // Effect to fetch audio and create blob URL
    useEffect(() => {
        let objectUrl: string | null = null; // Keep track locally

        const fetchAudioAndSetUrl = async () => {
            try {
                // Add try/catch for fetch errors
                const response = await fetch(audioUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch audio: ${response.statusText}`);
                }
                const blob = await response.blob();
                objectUrl = URL.createObjectURL(blob); // Assign to local variable
                setBlobUrl(objectUrl); // Update state
            } catch (error) {
                console.error("Error fetching audio blob:", error);
                setBlobUrl(null); // Reset blob url on error
            }
        };

        fetchAudioAndSetUrl();

        // Cleanup function
        return () => {
            if (objectUrl) {
                console.log("Revoking object URL:", objectUrl);
                URL.revokeObjectURL(objectUrl); // Revoke the URL using the local variable
            }
            setBlobUrl(null); // Also clear state on cleanup/dependency change
        };
    }, [audioUrl]); // Re-run if audioUrl changes

    const zoomviewContainerRef = useRef<HTMLDivElement>(null);
    const overviewContainerRef = useRef<HTMLDivElement>(null);
    const audioElementRef = useRef<HTMLAudioElement>(null);
    const peakMeterRef = useRef<HTMLDivElement>(null);

    const [peaksInstance, setPeaksInstance] = useState<PeaksInstance | null>(
        null
    );
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserNodeRef = useRef<AnalyserNode | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null); // Ref for source node
    const animationFrameIdRef = useRef<number | null>(null);
    const isInitializingRef = useRef(false); // Initialization lock flag

    const [isNormalized, setIsNormalized] = useState(false); // State for the toggle
    const [originalWaveformData, setOriginalWaveformData] = useState<JsonWaveformData | null>(null);
    const [processedWaveformData, setProcessedWaveformData] = useState<JsonWaveformData | null>(null);

    // Single Effect for Fetching Data and Initialization
    useEffect(() => {
        // Initial guard: Check if necessary refs/props are present
        if (
            !zoomviewContainerRef.current ||
            !overviewContainerRef.current ||
            !audioElementRef.current ||
            !blobUrl ||
            !waveformDataUrl
        ) {
            return; // Don't proceed until everything is available
        }

        // Prevent re-entry if already initializing
        if (isInitializingRef.current) {
            console.log("Initialization already in progress, skipping effect run.");
            return;
        }
        isInitializingRef.current = true; // Set lock
        console.log(`Starting initialization sequence for: ${blobUrl}`);

        // Keep track of the audio element for adding/removing listener
        const audioEl = audioElementRef.current;

        // Define the event handler function *outside* the async function
        // so it can be referenced for removal in cleanup
        const handleAudioPlay = async () => {
            const ctx = audioContextRef.current;
            // Check if context exists and is suspended *when play is clicked*
            if (ctx && ctx.state === "suspended") {
                console.log("Attempting to resume AudioContext due to 'play' event...");
                try {
                    await ctx.resume();
                    console.log("AudioContext resumed successfully on play.");
                } catch (err) {
                    console.error("Failed to resume AudioContext on play:", err);
                    // Inform user? Disable UI?
                }
            }
        };

        // Async function to manage the initialization steps
        const initialize = async () => {
            let fetchedData: JsonWaveformData | null = null; // To hold fetched data
            let localAudioContext: AudioContext | null = null; // Local var for context
            let localSourceNode: MediaElementAudioSourceNode | null = null; // Local var for source
            let localAnalyserNode: AnalyserNode | null = null; // Local var for analyser
            let initSuccess = false; // Track overall success

            try {
                // --- Step 1: Fetch Waveform Data ---
                console.log(`Workspaceing waveform data from: ${waveformDataUrl}`);
                const response = await fetch(waveformDataUrl);
                if (!response.ok) {
                    throw new Error(
                        `Waveform data fetch failed! Status: ${response.status}`
                    );
                }
                fetchedData = (await response.json()) as JsonWaveformData;
                console.log("Waveform data fetched successfully.");
                if (!audioEl) throw new Error("Component unmounted during fetch");

                // --- Step 2: Setup AudioContext ---
                if (
                    !audioContextRef.current ||
                    audioContextRef.current.state === "closed"
                ) {
                    // ... (create or reuse context logic - same as before) ...
                    const existingContext = window._peaksAudioContext;
                    if (existingContext && existingContext.state === "running") {
                        localAudioContext = existingContext;
                        console.log("Reusing existing AudioContext.");
                    } else {
                        localAudioContext = new (window.AudioContext ||
                            (window as any).webkitAudioContext)();
                        window._peaksAudioContext = localAudioContext;
                        console.log("Created new AudioContext.");
                    }
                    audioContextRef.current = localAudioContext;
                } else {
                    localAudioContext = audioContextRef.current;
                    console.log("Using existing AudioContext from ref.");
                }
                // **DO NOT resume here automatically**
                // if (localAudioContext.state === 'suspended') { ... }

                // **ADD 'play' event listener here**
                if (audioEl) {
                    // Remove any potential previous listener first (belt-and-suspenders)
                    audioEl.removeEventListener("play", handleAudioPlay);
                    // Add the listener
                    audioEl.addEventListener("play", handleAudioPlay);
                    console.log(
                        "Added 'play' event listener to audio element for context resume."
                    );
                }

                if (!audioEl)
                    throw new Error("Component unmounted during audio context setup");

                // --- Step 3: Setup Audio Graph (Source -> Analyser -> Destination) ---
                if (!sourceNodeRef.current && !analyserNodeRef.current && audioEl) {
                    // ... (create source/analyser, connect, store in refs - same as before) ...
                    console.log("Setting up AnalyserNode and Source...");
                    localSourceNode = localAudioContext.createMediaElementSource(audioEl);
                    localAnalyserNode = localAudioContext.createAnalyser();
                    localAnalyserNode.fftSize = 256;
                    localSourceNode.connect(localAnalyserNode);
                    localAnalyserNode.connect(localAudioContext.destination);
                    sourceNodeRef.current = localSourceNode;
                    analyserNodeRef.current = localAnalyserNode;
                    console.log("Source and Analyser connected for metering.");
                } else {
                    console.log(
                        "Skipping Analyser/Source setup (already exists in refs)."
                    );
                }
                if (!audioEl) throw new Error("Component unmounted before Peaks init");

                // --- Step 4: Configure Peaks.js Options ---
                if (!fetchedData) {
                    throw new Error("Fetched waveform data is missing.");
                }
                const options: PeaksOptions = {
                    // ... (same options as before, using fetchedData) ...
                    zoomview: {
                        container: zoomviewContainerRef.current!,
                        waveformColor: "#00bfff",
                        playedWaveformColor: "#1E90FF",
                        playheadColor: "#ff0000",
                        axisGridlineColor: '#3e3f48'
                    },
                    overview: {
                        container: overviewContainerRef.current!,
                        waveformColor: "#cccccc",
                        playedWaveformColor: "#a0a0a0",
                        playheadColor: "#ff0000",
                        axisGridlineColor: '#3e3f48'
                    },
                    mediaElement: audioEl!,
                    waveformData: { json: fetchedData },
                };

                // --- Step 5: Initialize Peaks.js using Callback (wrapped in Promise) ---
                console.log("Initializing Peaks.js with precomputed data object...");
                await new Promise<void>((resolve, reject) => {
                    Peaks.init(options, (err, peaksInstanceCallback) => {
                        if (!audioEl) {
                            // Check element ref here too
                            console.log(
                                "Component unmounted before Peaks.init callback executed."
                            );
                            peaksInstanceCallback?.destroy();
                            return reject(new Error("Component unmounted during Peaks init"));
                        }
                        // ... (handle err, peaksInstanceCallback, setPeaksInstance, resolve/reject - same as before) ...
                        if (err) {
                            console.error("Peaks.init callback error:", err.message);
                            return reject(err); // Reject promise on error
                        }
                        if (!peaksInstanceCallback) {
                            return reject(
                                new Error(
                                    "Peaks.init callback returned null instance without error."
                                )
                            );
                        }
                        console.log("Peaks.js initialized successfully via callback.");
                        setPeaksInstance(peaksInstanceCallback);
                        initSuccess = true; // Mark overall success
                        resolve(); // Resolve the promise
                    });
                }); // End of Promise wrapping Peaks.init

                console.log("Initialization sequence completed successfully.");
            } catch (error: any) {
                console.error(
                    "Initialization sequence failed:",
                    error.message,
                    error.stack
                );
                // ... (cleanup logic in catch block - same as before) ...
                setPeaksInstance(null);
                if (analyserNodeRef.current) {
                    try {
                        analyserNodeRef.current.disconnect();
                    } catch (e) { }
                }
                if (sourceNodeRef.current) {
                    try {
                        sourceNodeRef.current.disconnect();
                    } catch (e) { }
                }
                analyserNodeRef.current = null;
                sourceNodeRef.current = null;
            } finally {
                // ALWAYS reset the initialization flag
                console.log(
                    `Initialization sequence finished. Success: ${initSuccess}. Resetting flag.`
                );
                isInitializingRef.current = false;
            }
        };

        initialize(); // Start the async initialization

        // --- Cleanup Function ---
        return () => {
            console.log(`Cleaning up effect for: ${blobUrl}`);
            isInitializingRef.current = false; // Reset flag

            // **Remove the event listener**
            if (audioEl) {
                audioEl.removeEventListener("play", handleAudioPlay);
                console.log("Removed 'play' event listener from audio element.");
            }

            // ... (rest of cleanup: destroy peaks, disconnect nodes, cancel animation - same as before) ...
            const instanceToDestroy = peaksInstance;
            if (instanceToDestroy) {
                instanceToDestroy.destroy();
                setPeaksInstance(null);
            }
            if (analyserNodeRef.current) {
                try {
                    analyserNodeRef.current.disconnect();
                } catch (e) { }
                analyserNodeRef.current = null;
            }
            if (sourceNodeRef.current) {
                try {
                    sourceNodeRef.current.disconnect();
                } catch (e) { }
                sourceNodeRef.current = null;
            }
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
            console.log("Effect cleanup complete.");
        };
        // Effect dependencies
    }, [blobUrl, waveformDataUrl]);

    // --- Effect for Peak Meter Animation ---
    useEffect(() => {
        const analyser = analyserNodeRef.current;
        const peakMeterElement = peakMeterRef.current;
        if (!analyser || !peakMeterElement) return;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        let isCancelled = false;
        const draw = () => {
            if (isCancelled || !analyserNodeRef.current || !peakMeterRef.current)
                return;
            animationFrameIdRef.current = requestAnimationFrame(draw);
            try {
                analyserNodeRef.current.getByteTimeDomainData(dataArray);
                let peak = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const value = Math.abs(dataArray[i] - 128);
                    if (value > peak) peak = value;
                }
                const normalizedPeak = peak / 128.0;
                peakMeterRef.current.style.transform = `scaleY(${normalizedPeak})`;
            } catch (error) {
                console.error("Error getting analyser data:", error);
                isCancelled = true;
                if (animationFrameIdRef.current)
                    cancelAnimationFrame(animationFrameIdRef.current);
            }
        };
        console.log("Starting peak meter animation...");
        draw();
        return () => {
            console.log("Stopping peak meter animation...");
            isCancelled = true;
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
            if (peakMeterRef.current) {
                peakMeterRef.current.style.transform = `scaleY(0)`;
            }
        };
    }, [analyserNodeRef.current]);

    // --- Render Component --- (No changes needed)
    // ... (Same JSX as previous version) ...
    return (
        <div className="waveform-player-container">
            <div
                id="zoomview-container"
                ref={zoomviewContainerRef}
                className="waveform-zoomview"
            ></div>
            <div
                id="overview-container"
                ref={overviewContainerRef}
                className="waveform-overview"
            ></div>
            <audio
                id="audio"
                ref={audioElementRef}
                src={blobUrl ?? undefined}
                controls
                crossOrigin="anonymous"
            >
                Your browser does not support the audio element.
            </audio>
            <div className="peak-meter-container">
                Peak:
                <div className="peak-meter-bar-container">
                    <div ref={peakMeterRef} className="peak-meter-bar"></div>
                </div>
            </div>
        </div>
    );
};

export default WaveformPlayer;
