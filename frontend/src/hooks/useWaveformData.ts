// src/hooks/useWaveformData.ts

import { useState, useEffect } from 'react';
import { GetWaveform } from '@wails/go/main/App';
import { main } from "@wails/go/models";
import type { ActiveClip } from '../types'; // Adjust path to types.ts



export function useWaveformData(
    activeClip: ActiveClip | null,
    fps: number | 30,
    httpPort: number | null
) {
    const TARGET_PEAK_COUNT = 256;
    const ASSUMED_SAMPLE_RATE = 48000; 
    const MIN_SAMPLES_PER_PIXEL = 256;

    const [cutAudioSegmentUrl, setCutAudioSegmentUrl] = useState<string | null>(null);
    const [peakData, setPeakData] = useState<main.PrecomputedWaveformData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);


    useEffect(() => {
        // This is the same logic from your main component's useEffect
        if (
        activeClip &&
        fps &&
        httpPort &&
        typeof activeClip.sourceStartFrame === "number" &&
        typeof activeClip.sourceEndFrame === "number"
        ) {
        const clipStartSeconds = activeClip.sourceStartFrame / fps;
        const clipEndSeconds = activeClip.sourceEndFrame / fps;

        if (clipEndSeconds <= clipStartSeconds) {
            setPeakData(null);
            setCutAudioSegmentUrl(null);
            setError("Invalid clip segment duration.");
            return;
        }
        const clipDuration = clipEndSeconds - clipStartSeconds;
        const totalSamplesInClip = clipDuration * ASSUMED_SAMPLE_RATE;
        let dynamicSamplesPerPixel = Math.ceil(totalSamplesInClip / TARGET_PEAK_COUNT);
        dynamicSamplesPerPixel = Math.max(MIN_SAMPLES_PER_PIXEL, dynamicSamplesPerPixel);
        
        setError(null); // Clear previous errors

        // 1. Construct the URL for the cut audio segment
        const newCutAudioUrl = `http://localhost:${httpPort}/render_clip?file=${encodeURIComponent(
            activeClip.processedFileName
        )}&start=${clipStartSeconds.toFixed(3)}&end=${clipEndSeconds.toFixed(3)}`;
        setCutAudioSegmentUrl(newCutAudioUrl);

        // 2. Fetch peak data for this specific segment
        let isCancelled = false;
        const fetchClipPeaks = async () => {
            setIsLoading(true);
            try {
            const peakDataForSegment = await GetWaveform(
                activeClip.processedFileName,
                256, "logarithmic", -60.0,
                clipStartSeconds,
                clipEndSeconds
            );

            if (!isCancelled) {
                if (peakDataForSegment && peakDataForSegment.peaks?.length > 0) {
                setPeakData(peakDataForSegment);
                } else {
                setPeakData(null);
                setError("Received invalid peak data for segment.");
                }
            }
            } catch (e: any) {
            if (!isCancelled) {
                setPeakData(null);
                setError(e.message || "Error fetching peak data.");
            }
            } finally {
            if (!isCancelled) setIsLoading(false);
            }
        };

        fetchClipPeaks();
        return () => {
            isCancelled = true;
        };
        } else {
        // Reset if no valid active clip or necessary data
        setPeakData(null);
        setCutAudioSegmentUrl(null);
        setError(null);
        }
    }, [activeClip, fps, httpPort]);

    return { cutAudioSegmentUrl, peakData, isLoading, error };
}