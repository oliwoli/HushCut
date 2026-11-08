// src/hooks/useWaveformData.ts

import { useState, useEffect, useMemo } from 'react';
import { GetWaveform } from '@wails/go/main/App';
import { main } from '@wails/go/models';
import type { ActiveClip } from '../types';
import { useAppState } from '@/stores/appSync';
import { getClipParams, useClipStore } from '@/stores/clipStore';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import deepEqual from 'fast-deep-equal';
import { v5 as uuidv5 } from 'uuid';
import { LRUCache } from "lru-cache";

const MY_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';

interface GroupConstituentWaveformSpec {
    id: string;
    processedFileName: string;
    sourceStartFrame: number;
    sourceEndFrame: number;
    startFrame: number;
    thresholdOffsetDb: number;
}

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

function getItemHash(processedFileName: string, sourceStartFrame: number, sourceEndFrame: number): string {
    return uuidv5(`${processedFileName}-${sourceStartFrame}-${sourceEndFrame}`, MY_NAMESPACE);
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
    const clipId = activeClip?.id ?? '';

    // Track active constituent clips and their relative threshold offsets (groupAvg - clipThreshold)
    // when viewing a linked group in Combined Overview.
    // Note: Adjusting a slider in Combined Overview offsets all clips and the group average equally,
    // so `thresholdOffsetDb` remains constant during Combined Overview slider dragging.
    const groupConstituentSpecs = useStoreWithEqualityFn(
        useClipStore,
        (s): GroupConstituentWaveformSpec[] | null => {
            if (!clipId) return null;
            const constituents = s.groupToClips?.[clipId];
            if (!constituents || constituents.length === 0) return null;

            const activeConstituents = constituents.filter((cid) => !getClipParams(s, cid).bypassed);
            const targetConstituents = activeConstituents.length > 0 ? activeConstituents : constituents;

            let sumThreshold = 0;
            for (const cid of targetConstituents) {
                sumThreshold += getClipParams(s, cid).threshold;
            }
            const avgThreshold = sumThreshold / targetConstituents.length;

            const specs: GroupConstituentWaveformSpec[] = [];
            for (const cid of targetConstituents) {
                const item = s.timelineItems?.[cid];
                if (!item || !item.processed_file_name) continue;
                const cThresh = getClipParams(s, cid).threshold;
                specs.push({
                    id: cid,
                    processedFileName: item.processed_file_name,
                    sourceStartFrame: item.source_start_frame,
                    sourceEndFrame: item.source_end_frame,
                    startFrame: item.start_frame,
                    thresholdOffsetDb: Math.round((avgThreshold - cThresh) * 100) / 100,
                });
            }
            return specs.length > 0 ? specs : null;
        },
        deepEqual
    );

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

        // Helper to generate the URL
        const start = activeClip.sourceStartFrame / fps;
        const end = activeClip.sourceEndFrame / fps;
        const generateUrl = () => 
            `http://localhost:${httpPort}/render_clip?file=${encodeURIComponent(
                activeClip.processedFileName
            )}&start=${start}&end=${end}&token=${token}`;

        // Linked Group Combined Overview: compute pointwise maximum envelope across active constituents
        if (groupConstituentSpecs && groupConstituentSpecs.length > 0) {
            const groupSig = groupConstituentSpecs
                .map((c) => `${c.id}:${c.thresholdOffsetDb}`)
                .join('|');
            const groupCacheKey = `${clipHash}-${fps}-group-${groupSig}`;

            if (globalWaveformCache.has(groupCacheKey)) {
                const cachedGroupData = globalWaveformCache.get(groupCacheKey);
                if (cachedGroupData) {
                    setPeakData(cachedGroupData);
                    setCutAudioSegmentUrl(generateUrl());
                    setIsLoading(false);
                    setError(null);
                    return;
                }
            }

            let isActive = true;
            setIsLoading(true);
            setError(null);

            const fetchGroupWaveform = async () => {
                try {
                    if (end <= start) throw new Error("Invalid duration");
                    const groupDuration = end - start;
                    const groupMinStartFrame = activeClip.startFrame;

                    const itemWaveforms = await Promise.all(
                        groupConstituentSpecs.map(async (spec) => {
                            const cStart = spec.sourceStartFrame / fps;
                            const cEnd = spec.sourceEndFrame / fps;
                            if (cEnd <= cStart) return null;

                            const itemHash = getItemHash(
                                spec.processedFileName,
                                spec.sourceStartFrame,
                                spec.sourceEndFrame
                            );
                            const itemCacheKey = `${itemHash}-${fps}`;
                            let wf: main.PrecomputedWaveformData | null | undefined =
                                globalWaveformCache.get(itemCacheKey);
                            if (!wf) {
                                wf = await GetWaveform(
                                    spec.processedFileName,
                                    128,
                                    "logarithmic",
                                    -60.0,
                                    cStart,
                                    cEnd
                                );
                                if (wf && wf.peaks?.length > 0) {
                                    globalWaveformCache.set(itemCacheKey, wf);
                                }
                            }
                            if (!wf || !wf.peaks || wf.peaks.length === 0 || wf.duration <= 0) {
                                return null;
                            }
                            return { spec, wf };
                        })
                    );

                    const validItems = itemWaveforms.filter(
                        (entry): entry is { spec: GroupConstituentWaveformSpec; wf: main.PrecomputedWaveformData } =>
                            entry !== null
                    );

                    if (validItems.length === 0) {
                        // Fallback to direct GetWaveform on activeClip
                        const fallbackData = await GetWaveform(
                            activeClip.processedFileName,
                            128,
                            "logarithmic",
                            -60.0,
                            start,
                            end
                        );
                        if (isActive && fallbackData && fallbackData.peaks?.length > 0) {
                            globalWaveformCache.set(groupCacheKey, fallbackData);
                            setPeakData(fallbackData);
                            setCutAudioSegmentUrl(generateUrl());
                        }
                        return;
                    }

                    const peaksPerSec = validItems[0].wf.peaks.length / validItems[0].wf.duration;
                    const totalPeaks = Math.max(1, Math.round(groupDuration * peaksPerSec));
                    const combinedPeaks = new Array<number>(totalPeaks).fill(0);

                    for (const { spec, wf } of validItems) {
                        const offsetSec = (spec.startFrame - groupMinStartFrame) / fps;
                        const offsetIdx = Math.round(offsetSec * peaksPerSec);
                        const shiftVisual = spec.thresholdOffsetDb / 60.0;

                        for (let i = 0; i < wf.peaks.length; i++) {
                            const targetIdx = offsetIdx + i;
                            if (targetIdx >= 0 && targetIdx < totalPeaks) {
                                const rawPeak = wf.peaks[i];
                                const adjPeak =
                                    rawPeak > 0
                                        ? Math.max(0, Math.min(1, rawPeak + shiftVisual))
                                        : 0;
                                if (adjPeak > combinedPeaks[targetIdx]) {
                                    combinedPeaks[targetIdx] = adjPeak;
                                }
                            }
                        }
                    }

                    if (isActive) {
                        const combinedData = new main.PrecomputedWaveformData({
                            duration: groupDuration,
                            peaks: combinedPeaks,
                        });
                        globalWaveformCache.set(groupCacheKey, combinedData);
                        setPeakData(combinedData);
                        setCutAudioSegmentUrl(generateUrl());
                    }
                } catch (e: any) {
                    if (isActive) {
                        setPeakData(null);
                        setCutAudioSegmentUrl(null);
                        setError(e.message || "Error fetching group waveform");
                    }
                } finally {
                    if (isActive) setIsLoading(false);
                }
            };

            fetchGroupWaveform();

            return () => {
                isActive = false;
            };
        }

        const cacheKey = `${clipHash}-${fps}`;
        
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
    }, [clipHash, fps, httpPort, token, groupConstituentSpecs]);

    return { cutAudioSegmentUrl, peakData, isLoading, error };
}