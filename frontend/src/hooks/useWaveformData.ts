// src/hooks/useWaveformData.ts

import { useState, useEffect, useMemo } from 'react';
import { GetWaveform } from '@wails/go/main/App';
import { main } from '@wails/go/models';
import type { ActiveClip } from '../types';
import { useAppState } from '@/stores/appSync';
import { v5 as uuidv5 } from 'uuid';
import { LRUCache } from "lru-cache";

const MY_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

// GLOBAL CACHE: Defined outside the hook.
// This persists even if the component using the hook is unmounted/remounted (key change).
const globalWaveformCache = new LRUCache<string, main.PrecomputedWaveformData>({
    maxSize: 1024 * 1024 * 100, // 100 MB total
    sizeCalculation: (value, key) => {
        // rough estimate: Float32Array.length * 4 bytes per sample
        return value.peaks.length * 4;
    },
})

function getClipHash(activeClip: ActiveClip): string {
    return uuidv5(`${activeClip.processedFileName}-${activeClip.sourceStartFrame}-${activeClip.sourceEndFrame}`, MY_NAMESPACE);
}

export function useWaveformData(
    activeClip: ActiveClip | null,
    fps: number | 30,
    httpPort: number | null,
) {
    const [cutAudioSegmentUrl, setCutAudioSegmentUrl] = useState<string | null>(null);
    const [peakData, setPeakData] = useState<main.PrecomputedWaveformData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const token = useAppState(s => s.token);

    // 1. Stable Hash Calculation
    // We only recalculate if the specific frame/file properties change.
    const clipHash = useMemo(() => {
        if (
            !activeClip ||
            typeof activeClip.sourceStartFrame !== 'number' ||
            typeof activeClip.sourceEndFrame !== 'number'
        ) {
            return null;
        }
        return getClipHash(activeClip);
    }, [
        activeClip?.processedFileName,
        activeClip?.sourceStartFrame,
        activeClip?.sourceEndFrame
    ]);

    // 2. Fetch / Cache Logic
    useEffect(() => {
        // Reset state if inputs are invalid
        if (!clipHash || !activeClip || !httpPort || !fps) {
            setPeakData(null);
            setCutAudioSegmentUrl(null);
            setIsLoading(false);
            return;
        }

        const cacheKey = `${clipHash}-${fps}`;
        
        // Helper to generate the URL
        const start = activeClip.sourceStartFrame / fps;
        const end = activeClip.sourceEndFrame / fps;
        const generateUrl = () => 
            `http://localhost:${httpPort}/render_clip?file=${encodeURIComponent(
                activeClip.processedFileName
            )}&start=${start}&end=${end}&token=${token}`;

        // A. CACHE HIT:
        // If data exists globally, load it immediately and DO NOT run any async logic.
        if (globalWaveformCache.has(cacheKey)) {
            const cachedData = globalWaveformCache.get(cacheKey);
            if (cachedData) {
                console.log("cache hit: ", clipHash);
                setPeakData(cachedData);
                setCutAudioSegmentUrl(generateUrl());
                setIsLoading(false);
                setError(null);
                return; // STOP HERE. No fetch.
            }
        }

        // B. CACHE MISS:
        // Proceed to fetch. Use a flag to prevent setting state if unmounted.
        let isActive = true;
        
        setIsLoading(true);
        setError(null);
        // Optional: Clear old data while loading. 
        // setPeakData(null); 
        // setCutAudioSegmentUrl(null);

        const fetchClipData = async () => {
            try {
                if (end <= start) throw new Error("Invalid duration");

                // Execute Backend Call
                const data = await GetWaveform(
                    activeClip.processedFileName,
                    128, "logarithmic", -60.0,
                    start,
                    end
                );

                // Only update state if this effect is still active (clip hasn't changed)
                if (isActive) {
                    if (data && data.peaks?.length > 0) {
                        // Update Global Cache
                        globalWaveformCache.set(cacheKey, data);
                        
                        // Update Local State
                        setPeakData(data);
                        setCutAudioSegmentUrl(generateUrl());
                    } else {
                        throw new Error("Invalid peak data");
                    }
                }
            } catch (e: any) {
                if (isActive) {
                    // Only error if we don't have partial data
                    setPeakData(null);
                    setCutAudioSegmentUrl(null);
                    setError(e.message || "Error fetching waveform");
                }
            } finally {
                if (isActive) setIsLoading(false);
            }
        };

        fetchClipData();

        // Cleanup function
        return () => {
            isActive = false;
        };
    }, [clipHash, fps, httpPort, token]); // Dependencies are strictly primitives (except token)

    return { cutAudioSegmentUrl, peakData, isLoading, error };
}