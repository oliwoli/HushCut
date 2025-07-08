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
        setIsLoading(true);
        if (
            !activeClip ||
            !fps ||
            !httpPort ||
            typeof activeClip.sourceStartFrame !== "number" ||
            typeof activeClip.sourceEndFrame !== "number"
        ) {
            setPeakData(null);
            setCutAudioSegmentUrl(null);
            setError(null);
            setIsLoading(false);
            return;
        }

        let isCancelled = false;
        const fetchClipData = async () => {
            setIsLoading(true);
            setError(null);
            setPeakData(null);
            setCutAudioSegmentUrl(null);

            try {
                const clipStartSeconds = activeClip.sourceStartFrame / fps;
                const clipEndSeconds = activeClip.sourceEndFrame / fps;

                if (clipEndSeconds <= clipStartSeconds) {
                    setError("Invalid clip segment duration.");
                    setIsLoading(false);
                    return;
                }

                const newCutAudioUrl = `http://localhost:${httpPort}/render_clip?file=${encodeURIComponent(
                    activeClip.processedFileName
                )}&start=${clipStartSeconds}&end=${clipEndSeconds}`;

                const peakDataForSegment = await GetWaveform(
                    activeClip.processedFileName,
                    128, "logarithmic", -60.0,
                    clipStartSeconds,
                    clipEndSeconds
                );

                if (!isCancelled) {
                    if (peakDataForSegment && peakDataForSegment.peaks?.length > 0) {
                        setPeakData(peakDataForSegment);
                        setCutAudioSegmentUrl(newCutAudioUrl);
                    } else {
                        setPeakData(null);
                        setCutAudioSegmentUrl(null);
                        setError("Received invalid peak data for segment.");
                    }
                }
            } catch (e: any) {
                if (!isCancelled) {
                    setPeakData(null);
                    setCutAudioSegmentUrl(null);
                    setError(e.message || "Error fetching peak data.");
                }
            } finally {
                if (!isCancelled) setIsLoading(false);
            }
        };

        fetchClipData();

        return () => {
            isCancelled = true;
        };
    }, [activeClip, fps, httpPort]);
    console.log("peakData: ", peakData);
    console.log("cutAudioSegmentUrl: ", cutAudioSegmentUrl);

    return { cutAudioSegmentUrl, peakData, isLoading, error };
}