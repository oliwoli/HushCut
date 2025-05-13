// WaveformWithMeter.tsx
import React, { useEffect, useRef, useState, useCallback } from "react";
import WaveSurfer from "wavesurfer.js";
import { Button } from "../ui/button"; // Assuming you have this Shadcn UI component
import { PauseIcon, PlayIcon } from "lucide-react";
import './WaveformWithMeter.css'; // Import the CSS file for styling

// Constants
const MIN_DB = -70; // Minimum decibel level (Adjusted for typical range)
const FFT_SIZE = 512; // Optimized FFT size (power of 2)
// Smoothing factor (0 < alpha < 1). Smaller = more smoothing.
const SMOOTHING_FACTOR = 0.7; // Adjust as needed (e.g., 0.5 to 0.9)

export const Waveform: React.FC = () => {
    // Refs for DOM elements and WaveSurfer instance
    const waveformRef = useRef<HTMLDivElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const wsRef = useRef<WaveSurfer | null>(null);

    // Refs for Web Audio API objects
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);

    // Ref for Animation Frame ID
    const rafRef = useRef<number | null>(null); // requestAnimationFrame ID

    // Component State
    const [blobUrl, setBlobUrl] = useState<string>();
    const [playing, setPlaying] = useState(false); // Still needed for button state/icon
    const [audioReady, setAudioReady] = useState(false);
    const [meterValueDbRaw, setMeterValueDbRaw] = useState<number>(MIN_DB);
    const [smoothedMeterDb, setSmoothedMeterDb] = useState<number>(MIN_DB);

    // --- Web Audio API Setup ---
    const setupAudioContext = useCallback(() => {
        if (!audioRef.current || audioCtxRef.current) return;
        console.log("Setting up AudioContext...");
        try {
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = 0; // Use manual EMA smoothing

            const source = audioCtx.createMediaElementSource(audioRef.current);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);

            audioCtxRef.current = audioCtx;
            analyserRef.current = analyser;
            sourceRef.current = source;
            console.log("AudioContext setup complete.");
        } catch (error) {
            console.error("Error setting up Web Audio API:", error);
        }
    }, []);

    // --- Metering Loop (Continuous Strategy) ---
    const analyseAndSmooth = useCallback(() => {
        const analyser = analyserRef.current;
        // Check playing state directly from WaveSurfer ref inside the loop
        const isCurrentlyPlaying = wsRef.current?.isPlaying() ?? false;

        if (isCurrentlyPlaying && analyser) {
            // --- Perform analysis and update state ---
            const bufferLength = analyser.frequencyBinCount; // = fftSize / 2
            const dataArray = new Float32Array(bufferLength);
            analyser.getFloatTimeDomainData(dataArray); // Fill dataArray

            // Calculate RMS
            let sumOfSquares = 0;
            for (let i = 0; i < bufferLength; i++) {
                sumOfSquares += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sumOfSquares / bufferLength);

            // Convert RMS to Decibels
            let db = MIN_DB;
            if (rms > 0) { // Avoid Math.log10(0)
                db = 20 * Math.log10(rms);
                db = Math.max(MIN_DB, db); // Clamp to minimum
            }
            const currentDb = isFinite(db) ? db : MIN_DB; // Ensure finite value

            // Update raw dB state (optional)
            setMeterValueDbRaw(currentDb);

            // Calculate Smoothed Value using EMA
            setSmoothedMeterDb((prevSmoothedDb) => {
                const validPrevSmoothedDb = isFinite(prevSmoothedDb) ? prevSmoothedDb : MIN_DB;
                return SMOOTHING_FACTOR * currentDb + (1 - SMOOTHING_FACTOR) * validPrevSmoothedDb;
            });
            // --- End Analysis ---

        } else {
            // --- Reset meter when not playing ---
            // Use functional update and check previous value to avoid redundant renders
            setSmoothedMeterDb((prev) => (prev !== MIN_DB ? MIN_DB : prev));
            setMeterValueDbRaw((prev) => (prev !== MIN_DB ? MIN_DB : prev));
        }

        // --- Always schedule the next frame as long as context is running ---
        // The loop runs continuously, but only does work when playing.
        // It stops automatically if the context closes or during unmount cleanup.
        if (audioCtxRef.current?.state === 'running') {
            rafRef.current = requestAnimationFrame(analyseAndSmooth);
        } else {
            // Stop the loop if context is suspended or closed unexpectedly
            console.log("AudioContext not running, stopping RAF loop.");
            rafRef.current = null;
        }

    }, []); // analyseAndSmooth depends only on refs and state setters

    // --- Effects ---

    // Effect 1: Fetch Audio Data and Create Blob URL (Unchanged)
    useEffect(() => {
        let revoked = false;
        let currentBlobUrl: string | undefined;
        console.log("Fetching audio data...");
        fetch("/preview-render.wav")
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                return response.arrayBuffer();
            })
            .then(buffer => {
                const blob = new Blob([buffer], { type: "audio/wav" });
                const url = URL.createObjectURL(blob);
                currentBlobUrl = url;
                setBlobUrl(url);
                console.log("Blob URL created:", url);
            })
            .catch(error => console.error("Error fetching or processing audio file:", error));
        return () => {
            if (currentBlobUrl && !revoked) {
                console.log("Revoking Blob URL:", currentBlobUrl);
                URL.revokeObjectURL(currentBlobUrl);
                revoked = true;
            }
        };
    }, []);

    // Effect 2: Initialize WaveSurfer (Unchanged)
    useEffect(() => {
        // Only proceed if blobUrl is actually set.
        if (!blobUrl) {
            // This log helps confirm the effect runs initially but waits.
            console.log("Effect 2 waiting: blobUrl not ready yet.");
            return;
        }

        // Log when the effect is triggered by a valid blobUrl
        console.log(`Effect 2 triggered by blobUrl: ${blobUrl}`);

        // Use setTimeout to defer the main logic, allowing refs to populate.
        const timeoutId = setTimeout(() => {
            // This log confirms the deferred code is running.
            console.log("Effect 2 setTimeout executing...");

            // Get refs *inside* the timeout callback, they are more likely to be set now.
            const audioEl = audioRef.current;
            const waveEl = waveformRef.current;

            // Perform the necessary checks again *inside* the timeout.
            if (!audioEl || !waveEl || !document.body.contains(waveEl) || wsRef.current) {
                console.log("Effect 2 setTimeout PREVENTED WS init. Check:", {
                    '!audioEl': !audioEl,
                    '!waveEl': !waveEl,
                    '!waveElInDOM': waveEl ? !document.body.contains(waveEl) : 'waveEl is null',
                    'wsRef.current exists': !!wsRef.current,
                });
                return; // Exit if refs still not ready for some reason
            }

            // --- Start WaveSurfer Initialization (inside timeout) ---
            console.log("Attempting WaveSurfer.create inside setTimeout...");
            try {
                // Pass the validated refs
                wsRef.current = WaveSurfer.create({
                    container: waveEl, // Should be valid now
                    waveColor: "#888",
                    progressColor: "#4f46e5",
                    cursorColor: "#4f46e5",
                    height: 80,
                    media: audioEl, // Should be valid now
                });
                console.log("WaveSurfer instance potentially created:", wsRef.current);
                wsRef.current.load(blobUrl);
            } catch (error) {
                console.error("Error creating WaveSurfer instance:", error);
                setAudioReady(false); // Ensure button stays disabled on error
                return; // Stop if creation failed
            }

            const ws = wsRef.current;
            if (!ws) {
                console.error("WS instance is null after create attempt!");
                return;
            }

            // Define handlers
            const handleWsReady = () => {
                console.log("WaveSurfer ready event fired.");
                setAudioReady(true); // <<< SET AUDIO READY HERE
            };

            const handleWsError = (err: Error) => {
                console.error("WaveSurfer error event:", err);
                setAudioReady(false); // Disable button on error
            };
            const handleWsPlay = () => setPlaying(true);

            const handleWsPause = () => setPlaying(false);
            const handleWsFinish = () => setPlaying(false);

            // Attach listeners
            console.log("Attaching WaveSurfer event listeners inside setTimeout...");
            ws.on('ready', handleWsReady);
            ws.on('error', handleWsError);
            ws.on('play', handleWsPlay);
            ws.on('pause', handleWsPause);
            ws.on('finish', handleWsFinish);
            console.log("WaveSurfer listeners attached, waiting for 'ready'...");
            // --- End WaveSurfer Initialization ---

        }, 0); // Delay of 0ms pushes execution after current stack

        // --- Cleanup for useEffect ---
        // This runs if blobUrl changes again, or on unmount.
        return () => {
            console.log("Cleanup for Effect 2 triggered.");
            // Important: Clear the timeout if the effect cleans up before it fires.
            clearTimeout(timeoutId);
            console.log("Cleared potential setTimeout.");

            // Cleanup existing WaveSurfer instance if it was created
            const ws = wsRef.current;
            if (ws) {
                console.log("Destroying WaveSurfer instance in Effect 2 cleanup.");
                // Unsubscribe listeners first is good practice
                // ws.un(...); // Consider adding unsubscription here too if needed
                ws.destroy();
                wsRef.current = null;
            }
            // Reset states if necessary (though unmount effect might also do it)
            setAudioReady(false);
            setPlaying(false);
        };

    }, [blobUrl]); // Dependency remains on blobUrl

    // REMOVED: Effect 3 that started/stopped loop based on 'playing' state.

    // Effect 4: Cleanup Web Audio API resources on component unmount (Ensure RAF is cancelled)
    useEffect(() => {
        // Return cleanup function that runs only on unmount
        return () => {
            console.log("Cleaning up Web Audio API resources and stopping RAF loop...");

            // --- Stop the continuous RAF loop ---
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
                console.log("Stopped continuous RAF loop on unmount.");
            }

            // Disconnect Web Audio nodes
            sourceRef.current?.disconnect();
            analyserRef.current?.disconnect();

            // Close the AudioContext
            if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
                audioCtxRef.current.close()
                    .then(() => console.log("AudioContext closed."))
                    .catch(err => console.error("Error closing AudioContext:", err));
            }

            // Clear refs
            audioCtxRef.current = null;
            analyserRef.current = null;
            sourceRef.current = null;
        };
    }, []); // Empty dependency array ensures this runs only on unmount


    // --- Handlers ---
    const togglePlay = async () => {
        const ws = wsRef.current;
        if (!ws || !audioReady) {
            console.warn("Play/Pause clicked but WaveSurfer not ready.");
            return;
        }

        // 1) Set up context if it doesn't exist yet
        if (!audioCtxRef.current) {
            console.log("First interaction: setting up AudioContext…");
            setupAudioContext();
            if (!audioCtxRef.current) {
                console.error("AudioContext setup failed.");
                return;
            }
        }

        const audioCtx = audioCtxRef.current!;

        console.log("AudioContext state:", audioCtx.state);
        // 2) If suspended, resume it in this gesture
        if (audioCtx.state === "suspended") {
            console.log("Resuming suspended AudioContext…");
            try {
                await audioCtx.resume();
                console.log("AudioContext is now running.");
            } catch (err) {
                console.error("Failed to resume AudioContext:", err);
            }
        }

        // 3) Now that it’s running, start the metering loop if not already started
        if (audioCtx.state === "running" && rafRef.current === null) {
            console.log("Starting meter RAF loop…");
            // reset meters
            setMeterValueDbRaw(MIN_DB);
            setSmoothedMeterDb(MIN_DB);
            rafRef.current = requestAnimationFrame(analyseAndSmooth);
        }

        // 4) Finally toggle play/pause on the WaveSurfer instance
        if (ws.isPlaying()) {
            console.log("Pausing audio…");
            ws.pause();
        } else {
            console.log("Playing audio…");
            ws.play();
            if (ws.isPlaying()) {
                console.log("Audio is now playing.");
            }
            //ws.play();
        }
    };

    // --- Helper function to Calculate Bar Width Percentage (Unchanged) ---
    const calculateBarWidthPercent = (dbValue: number): number => {
        const range = 0 - MIN_DB;
        if (range <= 0) return 0;
        const clampedDb = Math.max(MIN_DB, Math.min(0, dbValue));
        const linearValue = (clampedDb - MIN_DB) / range;
        const clampedLinear = Math.max(0, Math.min(1, linearValue));
        return clampedLinear * 100;
    };

    const barWidthPercent = calculateBarWidthPercent(smoothedMeterDb);


    // --- Render Component (Unchanged) ---
    return (
        <div>
            <audio ref={audioRef} src={blobUrl} preload="auto" style={{ display: "none" }} />
            <div ref={waveformRef} style={{ marginBottom: '15px' }} />
            <div className="controls-meter-container">
                <Button
                    onClick={togglePlay}
                    disabled={!audioReady}
                    className="play-pause-button"
                    aria-label={playing ? "Pause audio" : "Play audio"}
                >
                    {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                </Button>
                <div className="meter-bar-container" title={`Level: ${smoothedMeterDb > MIN_DB ? smoothedMeterDb.toFixed(1) : '---'} dB`}>
                    <div
                        className="meter-bar-level"
                        style={{ width: `${barWidthPercent}%` }} // Assumes CSS transition handles smoothness
                    />
                </div>
            </div>
            {/* Optional Raw Debugging Text */}
            {/* <div style={{ fontFamily: 'monospace', fontSize: '10px', color: '#aaa', marginLeft: '10px' }}>
                 Raw: {meterValueDbRaw > MIN_DB ? meterValueDbRaw.toFixed(1) : '---'} dB | Smooth: {smoothedMeterDb > MIN_DB ? smoothedMeterDb.toFixed(1) : '---'} dB
             </div> */}
        </div>
    );
};