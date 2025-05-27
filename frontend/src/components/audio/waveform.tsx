import { PauseIcon, PlayIcon, RedoDotIcon, SkipForwardIcon } from "lucide-react";
import React, { useRef, useEffect, useState, useCallback } from "react";
import WaveSurfer, { WaveSurferOptions } from "wavesurfer.js";
import RegionsPlugin, { RegionParams, Region } from "wavesurfer.js/dist/plugins/regions.js";

import { GetLogarithmicWaveform } from "@wails/go/main/App";
import { main } from "@wails/go/models";

const formatAudioTime = (totalSeconds: number, frameRate: number, showHours: boolean = false): string => {
    if (isNaN(totalSeconds) || totalSeconds < 0) {
        return showHours ? "00:00:00" : "00:00";
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const frameNumber = Math.floor((totalSeconds % 1) * frameRate); // Calculate frame number based on frame rate

    const paddedFrameNumber = String(frameNumber).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');

    if (showHours || hours > 0) { // Show hours if forced or if there are any hours
        const paddedHours = String(hours).padStart(2, '0');
        return `${paddedHours}:${paddedMinutes}:${paddedSeconds};${paddedFrameNumber}`;
    } else {
        return `${paddedMinutes}:${paddedSeconds};${paddedFrameNumber}`;
    }
};

// Define SilencePeriod if it's not globally available
interface SilencePeriod {
    start: number;
    end: number;
}

interface WaveformPlayerProps {
    audioUrl: string;
    silenceData?: SilencePeriod[] | null;
    projectFrameRate?: number | 30.0; // Default to 30 FPS if not provided
}

const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
    audioUrl,
    silenceData,
    projectFrameRate
}) => {
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    useEffect(() => {
        let objectUrl: string | null = null;
        const fetchAudioAndSetUrl = async () => {
            if (!audioUrl) {
                setBlobUrl(null);
                return;
            }
            try {
                console.log("Fetching audio from:", audioUrl);
                const response = await fetch(audioUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch audio: ${response.statusText} (status: ${response.status})`);
                }
                console.log("Fetch response Content-Type header:", response.headers.get('Content-Type'));
                const originalBlob = await response.blob();
                console.log('Original fetched blob details:', { type: originalBlob.type, size: originalBlob.size });

                let finalBlob = originalBlob;
                // Attempt to fix MIME type if empty, based on URL extension (common cases)
                if (!originalBlob.type && originalBlob.size > 0) {
                    let assumedType: string | undefined;
                    if (audioUrl.toLowerCase().endsWith('.mp3')) assumedType = 'audio/mpeg';
                    else if (audioUrl.toLowerCase().endsWith('.wav')) assumedType = 'audio/wav';
                    else if (audioUrl.toLowerCase().endsWith('.ogg')) assumedType = 'audio/ogg';
                    else if (audioUrl.toLowerCase().endsWith('.aac')) assumedType = 'audio/aac';
                    else if (audioUrl.toLowerCase().endsWith('.flac')) assumedType = 'audio/flac';
                    // Add other common types your app might handle

                    if (assumedType) {
                        console.warn(`Original blob had no MIME type. Re-blobbing with assumed type: ${assumedType}`);
                        finalBlob = new Blob([originalBlob], { type: assumedType });
                        console.log('Re-blobbed details:', { type: finalBlob.type, size: finalBlob.size });
                    } else {
                        console.warn("Original blob had no MIME type and file extension is not recognized for common audio types.");
                    }
                } else if (originalBlob.size === 0) {
                    console.error("Fetched blob is empty (size 0). This will likely fail to load.");
                    // No point creating an object URL for an empty blob
                    setBlobUrl(null);
                    throw new Error("Fetched audio blob is empty.");
                }


                objectUrl = URL.createObjectURL(finalBlob);
                setBlobUrl(objectUrl);
            } catch (error) {
                console.error("Error fetching audio blob:", error);
                setBlobUrl(null);
            }
        };

        fetchAudioAndSetUrl();

        return () => {
            if (objectUrl) {
                console.log("Revoking object URL:", objectUrl);
                URL.revokeObjectURL(objectUrl);
            }
            setBlobUrl(null);
        };
    }, [audioUrl]);

    const waveformContainerRef = useRef<HTMLDivElement>(null);
    const wavesurferRef = useRef<WaveSurfer | null>(null);
    const regionsPluginRef = useRef<RegionsPlugin | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0); // State for current time

    const silenceDataRef = useRef(silenceData);
    useEffect(() => {
        silenceDataRef.current = silenceData;
    }, [silenceData]);

    const [precomputedData, setPrecomputedData] = useState<main.PrecomputedWaveformData | null>(null);
    const [skipRegionsEnabled, setSkipRegionsEnabled] = useState(false);

    // Refs to hold the latest values of state/props for use in WS event handlers
    const skipRegionsEnabledRef = useRef(skipRegionsEnabled);
    useEffect(() => {
        skipRegionsEnabledRef.current = skipRegionsEnabled;
    }, [skipRegionsEnabled]);

    const silenceDataForSkippingRef = useRef(silenceData); // Use a separate ref for data used in timeupdate
    useEffect(() => {
        silenceDataForSkippingRef.current = silenceData;
    }, [silenceData]);

    // Ref for the main silenceData prop used for rendering regions (if different logic applies)
    const silenceDataForDisplayRef = useRef(silenceData);
    useEffect(() => {
        silenceDataForDisplayRef.current = silenceData;
    }, [silenceData]);

    const currentProjectFrameRate = projectFrameRate || 30.0;

    // Effect to fetch precomputed data
    useEffect(() => {
        if (!audioUrl) {
            if (precomputedData !== null) setPrecomputedData(null); // Clear if no URL
            if (duration !== 0) setDuration(0);
            if (isLoading) setIsLoading(false);
            return;
        }

        let isCancelled = false; // To handle unmounting during async fetch

        const fetchPrecomputedData = async () => {
            console.log("Attempting to fetch precomputed data for:", audioUrl);
            setIsLoading(true); // Set loading true at the beginning of the fetch process

            try {
                const samplesPerPixel = 256;
                const minDisplayDb = -60.0;
                const data = await GetLogarithmicWaveform(audioUrl, samplesPerPixel, minDisplayDb);

                if (isCancelled) return;

                if (!data || !data.peaks || data.peaks.length === 0 || data.duration <= 0) {
                    console.error("Fetched precomputed data is invalid or empty:", data);
                    throw new Error("Invalid precomputed waveform data received.");
                }

                console.log("Successfully fetched precomputed data:", { duration: data.duration, numPeaks: data.peaks.length });

                // Only update state if the new data is meaningfully different
                // This simple check assumes data object reference changes or duration/peaks length change.
                // For deep comparison, you'd need a utility.
                if (
                    !precomputedData || // If no previous data
                    precomputedData.duration !== data.duration ||
                    precomputedData.peaks.length !== data.peaks.length
                    // Add more checks if necessary, e.g., a deep equals on peaks if they could change for same duration
                ) {
                    console.log("New precomputed data is different, updating state.");
                    setPrecomputedData(data);
                    setDuration(data.duration);
                } else {
                    console.log("Fetched precomputed data is the same as current, not updating state.");
                }
                // setIsLoading(false); // Moved to WaveSurfer 'ready' or 'error'
            } catch (error) {
                if (isCancelled) return;
                console.error("Error fetching precomputed waveform data:", error);
                if (precomputedData !== null) setPrecomputedData(null);
                if (duration !== 0) setDuration(0);
                setIsLoading(false); // Ensure loading is false on fetch error
            }
            // Do not set setIsLoading(false) here generally; WaveSurfer 'ready' is better.
            // However, if precomputed data fetch fails, WaveSurfer might not even try to load.
        };

        fetchPrecomputedData();

        return () => {
            isCancelled = true;
            console.log("Precomputed data fetch effect cleanup for:", audioUrl);
        };
    }, [audioUrl, precomputedData]);

    // Effect for WaveSurfer Initialization
    useEffect(() => {
        console.log("WaveSurfer Init Effect triggered. blobUrl:", !!blobUrl, "precomputedData:", !!precomputedData);

        if (!waveformContainerRef.current) {
            console.log("WS Init: Container ref not available.");
            return;
        }

        if (wavesurferRef.current) {
            console.log("WS Init: Destroying previous instance that used blob:", wavesurferRef.current.options.url);
            wavesurferRef.current.destroy();
            wavesurferRef.current = null;
        }

        if (!blobUrl || !precomputedData || !precomputedData.peaks || precomputedData.peaks.length === 0 || precomputedData.duration <= 0) {
            console.log("WS Init: Waiting for blobUrl or valid precomputedData (for peaks).", { /* ... */ });
            if (audioUrl && (!blobUrl || !precomputedData)) setIsLoading(true);
            else if (!audioUrl) setIsLoading(false);
            return;
        }

        console.log("WS Init: All conditions met for using precomputed peaks. Initializing with blob:", blobUrl);
        setIsLoading(true);
        setCurrentTime(0);

        const wsRegions = RegionsPlugin.create();
        regionsPluginRef.current = wsRegions;

        const wsOptions: WaveSurferOptions = {
            container: waveformContainerRef.current,
            dragToSeek: true,
            waveColor: "#777777",
            progressColor: "#777777",
            cursorColor: "#e64b3d",
            cursorWidth: 2,
            height: "auto",
            fillParent: true,
            // barWidth: 1,
            // barGap: 0,
            barAlign: "bottom",
            interact: true,
            url: blobUrl, // DO NOT set URL here for this test
            peaks: [precomputedData.peaks], // Still commented out for testing blob loading
            duration: precomputedData.duration, // Still commented out
            normalize: false,
            plugins: [wsRegions],
            backend: "MediaElement",
            mediaControls: false,
            hideScrollbar: true,
        };

        try {
            const ws = WaveSurfer.create(wsOptions);
            wavesurferRef.current = ws;

            ws.on("ready", () => {
                console.log("WaveSurfer: Event 'ready' fired.");
                setIsLoading(false);
                const internalWsDuration = ws.getDuration();
                console.log(`WaveSurfer internal duration: ${internalWsDuration}, Precomputed duration: ${precomputedData.duration}`);
                // If not providing duration to WS, it will calculate it.
                // Update your state if needed, or compare.
                if (Math.abs(internalWsDuration - duration) > 0.01) { // If 'duration' state isn't from precomputedData initially
                    setDuration(internalWsDuration); // Trust WS duration if it decoded itself
                }

                if (regionsPluginRef.current && silenceDataRef.current) {
                    updateSilenceRegions(regionsPluginRef.current, silenceDataRef.current);
                }
            });

            ws.on("decode", (decodedDuration: number) => {
                console.warn("WaveSurfer 'decode' event fired. Duration:", decodedDuration);
            });

            ws.on("play", () => setIsPlaying(true));
            ws.on("pause", () => setIsPlaying(false));
            ws.on("finish", () => setIsPlaying(false));
            ws.on("timeupdate", (time: number) => {
                setCurrentTime(time); // Update React state for UI display

                // Region Skipping Logic
                if (ws.isPlaying() && skipRegionsEnabledRef.current && silenceDataForSkippingRef.current && silenceDataForSkippingRef.current.length > 0) {
                    const currentRegionsToSkip = silenceDataForSkippingRef.current;
                    for (const region of currentRegionsToSkip) {
                        const epsilon = 0.05; // 50ms buffer. Adjust if needed.
                        if (region.end > region.start && time >= region.start && time < (region.end - epsilon)) {
                            console.log(`Region Skip: In [${region.start.toFixed(3)}-${region.end.toFixed(3)}] at ${time.toFixed(3)}. Seeking to ${region.end.toFixed(3)}`);
                            const seekProgress = region.end / ws.getDuration();
                            ws.seekTo(Math.min(1, Math.max(0, seekProgress))); // Ensure progress is between 0 and 1
                            // setCurrentTime(region.end); // Let next timeupdate from WS handle state update
                            break;
                        }
                    }
                }
            });
            ws.on("error", (err: Error | string) => { // WaveSurfer can emit string errors too
                const errorMessage = typeof err === 'string' ? err : err.message;
                console.error("WaveSurfer error event:", errorMessage, err);
                setIsLoading(false);
                setIsPlaying(false);
            });

        } catch (error: any) {
            console.error("Error during WaveSurfer create/load call:", error.message || error);
            setIsLoading(false);
            setIsPlaying(false);
        }

        return () => {
            if (wavesurferRef.current) {
                console.log("WaveSurfer cleanup: Destroying instance that used blobUrl:", blobUrl);
                wavesurferRef.current.destroy();
                wavesurferRef.current = null;
            }
        };
    }, [blobUrl, precomputedData]); // Dependencies remain the same


    const updateSilenceRegions = useCallback(
        (regionsPlugin: RegionsPlugin, sData: SilencePeriod[] | null | undefined) => {
            if (!regionsPlugin) return;
            regionsPlugin.clearRegions();
            if (sData && sData.length > 0) {
                console.log(`Adding ${sData.length} new silence regions.`);
                sData.forEach((period, index) => {
                    try {
                        const regionId = `silence-marker_${index}_${period.start.toFixed(2)}-${period.end.toFixed(2)}`;
                        const regionParams: RegionParams = {
                            id: regionId,
                            start: period.start,
                            end: period.end,
                            color: "rgba(255, 10, 5, 0.1)",
                            drag: false,
                            resize: false,
                        };
                        regionsPlugin.addRegion(regionParams);
                    } catch (e: any) {
                        console.error("Error adding silence region:", period, e.message || e);
                    }
                });
            }
        },
        []
    );

    useEffect(() => {
        if (!isLoading && wavesurferRef.current && regionsPluginRef.current) {
            console.log("SilenceData prop changed or WaveSurfer ready, updating regions.");
            updateSilenceRegions(regionsPluginRef.current, silenceDataRef.current);
        }
    }, [silenceData, isLoading, updateSilenceRegions]);


    const handlePlayPause = useCallback(() => {
        if (wavesurferRef.current && !isLoading) {
            wavesurferRef.current.playPause();
        }
    }, [isLoading]);

    // Toggle function for skipping regions
    const toggleSkipRegions = useCallback(() => {
        setSkipRegionsEnabled(prev => !prev);
    }, []);

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        console.log(`Keydown: ${event.key}. isPlaying=${isPlaying}, isLoading=${isLoading}, duration=${duration}`);
        if (!wavesurferRef.current || isLoading || !duration || isPlaying || currentProjectFrameRate <= 0) {
            console.log("Keydown: Bailing out.");
            return;
        }

        const ws = wavesurferRef.current;
        const frameRate = currentProjectFrameRate;

        // Use actual current time from WaveSurfer for calc, but React state for comparison to avoid redundant ops
        const currentWsTime = ws.getCurrentTime();
        const currentFrameIndex = Math.floor(currentWsTime * frameRate); // Frame we are currently in or just passed

        let targetAbsoluteFrame;
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            targetAbsoluteFrame = currentFrameIndex + 1;
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            targetAbsoluteFrame = currentFrameIndex - 1;
        } else {
            return;
        }

        let newTargetTime = targetAbsoluteFrame / frameRate;

        // Clamp to duration boundaries
        if (newTargetTime < 0) newTargetTime = 0;
        const maxFrame = Math.floor(duration * frameRate) - 1; // last possible frame index.
        const lastFrameStartTime = maxFrame / frameRate;

        if (newTargetTime > duration) newTargetTime = duration;
        newTargetTime = Math.max(0, Math.min(duration, newTargetTime));

        const precisionFactor = Math.pow(10, Math.ceil(Math.log10(frameRate)) + 4); // Higher precision
        newTargetTime = Math.round(newTargetTime * precisionFactor) / precisionFactor;

        const timeEpsilon = 1 / (frameRate * 100); // A small tolerance
        if (Math.abs(newTargetTime - currentWsTime) < timeEpsilon) {
            if (Math.abs(currentTime - newTargetTime) > timeEpsilon) {
                setCurrentTime(newTargetTime);
            }
            return;
        }

        console.log(`Stepping: currentFrameIdx=${currentFrameIndex}, targetFrameAbs=${targetAbsoluteFrame}, newTargetTime=${newTargetTime.toFixed(5)}`);

        setCurrentTime(newTargetTime); // Optimistic update for UI
        ws.seekTo(newTargetTime / duration); // WaveSurfer seek (0-1)

    }, [isLoading, duration, isPlaying, currentProjectFrameRate, currentTime, setCurrentTime]);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [handleKeyDown]);


    const quantizedCurrentTimeForDisplay = Math.round(currentTime * currentProjectFrameRate) / currentProjectFrameRate;
    const quantizedDurationForDisplay = Math.round(duration * currentProjectFrameRate) / currentProjectFrameRate; // Good for duration too

    const showHoursFormat = duration >= 3600;
    const formattedCurrentTime = formatAudioTime(quantizedCurrentTimeForDisplay, currentProjectFrameRate, showHoursFormat);
    const formattedDuration = formatAudioTime(quantizedDurationForDisplay, currentProjectFrameRate, showHoursFormat);

    return (
        <div className="pointer-events-auto">
            <div ref={waveformContainerRef} className="h-64 bg-[#2c2d32] border-2 border-stone-900 rounded-md box-border overflow-hidden">
                {isLoading && <div className="loading-overlay">Loading waveform...</div>}
            </div>
            <div className="items-center flex justify-start py-2 gap-2">
                <button onClick={handlePlayPause} disabled={isLoading || !duration}>
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>

                {!isLoading && duration > 0 && (
                    <button
                        onClick={toggleSkipRegions}
                        className={`p-1.5 border rounded flex items-center text-xs ${skipRegionsEnabled ? 'bg-sky-500 text-white dark:bg-sky-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'}`}
                        title={skipRegionsEnabled ? "Disable skipping regions" : "Enable skipping regions"}
                    >
                        <RedoDotIcon size={18} className="mr-1" />
                        {/* {skipRegionsEnabled ? "Skip ON" : "Skip OFF"} */}
                    </button>
                )}

                {!isLoading && duration > 0 && (
                    <span className="ml-2 text-sm gap-1.5 flex pt-1 text-gray-400">
                        <span>{formattedCurrentTime}</span> / <span>{formattedDuration}</span>
                    </span>
                )}
            </div>
        </div>
    );
};

export default WaveformPlayer;