import { usePlaybackStore } from '@/stores/clipStore';
import { main } from '@wails/go/models';
import React, { useEffect, useRef } from 'react';

// Helper functions can live in this file or a shared utils file
const computePeakEnvelope = (data: number[], duration: number, fps = 60) => {
    const frameCount = Math.ceil(duration * fps);
    if (frameCount <= 0) return [];
    const samplesPerFrame = data.length / frameCount;
    const envelope = new Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
        let max = 0;
        const start = Math.floor(i * samplesPerFrame);
        const end = Math.floor((i + 1) * samplesPerFrame);
        for (let j = start; j < end; j++) {
            max = Math.max(max, Math.abs(data[j] ?? 0));
        }
        envelope[i] = max;
    }
    return envelope;
};

const normalizedToDb = (normalizedVal: number, minDb: number, maxDb: number) => {
    if (normalizedVal <= 0) return minDb;
    if (normalizedVal >= 1) return maxDb;
    const dbRange = maxDb - minDb;
    return (normalizedVal * dbRange) + minDb;
};

const getColorForDb = (db: number) => {
    if (db > -8) return '#ef4444'; // Red
    if (db > -18) return '#facc15'; // Yellow
    return '#22c55e'; // Green
};

interface PeakMeterProps {
    peakData: main.PrecomputedWaveformData | null;
}

export const PeakMeter: React.FC<PeakMeterProps> = ({ peakData }) => {
    const peakMeterRef = useRef<HTMLDivElement>(null);
    const peakHoldRef = useRef<HTMLDivElement>(null);

    const heldPeakValueRef = useRef(0);
    const heldPeakTimeRef = useRef(0);
    const peakMeterDisplayValueRef = useRef(0);
    const peakIsVisibleRef = useRef(false);

    useEffect(() => {
        if (!peakData?.peaks?.length || !peakData.duration || !peakMeterRef.current) {
            if (peakMeterRef.current) {
                peakMeterRef.current.style.transform = 'scaleY(0)';
            }
            if (peakHoldRef.current) {
                peakHoldRef.current.style.opacity = '0';
            }
            return;
        }

        const { peaks: waveformDataPoints, duration } = peakData;
        const peakEnvelope = computePeakEnvelope(waveformDataPoints, duration);
        if (peakEnvelope.length === 0) return;

        let animationFrameId: number | null = null;

        const holdDuration = 1000;
        const falloffRate = 0.005;
        const attackRate = 0.6;
        const releaseRate = 0.1;
        const minDisplayDb = -60.0;
        const maxDisplayDb = 0.0;

        const updatePeakMeter = () => {
            const now = performance.now();
            // Non-reactively get the latest value from the store
            const { currentTime, isPlaying } = usePlaybackStore.getState();


            const frameIndex = Math.min(
                Math.floor((currentTime / duration) * peakEnvelope.length),
                peakEnvelope.length - 1
            );

            const targetValue = peakEnvelope[frameIndex] ?? 0;
            let displayValue = peakMeterDisplayValueRef.current;

            if (isPlaying) {
                displayValue = targetValue > displayValue
                    ? attackRate * targetValue + (1 - attackRate) * displayValue
                    : releaseRate * targetValue + (1 - releaseRate) * displayValue;
            } else {
                displayValue = Math.max(0, displayValue - falloffRate);
            }

            const peakHasExpired = now - heldPeakTimeRef.current > holdDuration;

            if (isPlaying && targetValue > heldPeakValueRef.current) {
                heldPeakValueRef.current = targetValue;
                heldPeakTimeRef.current = now;
                peakIsVisibleRef.current = true;
            } else if (peakHasExpired) {
                if (isPlaying) {
                    heldPeakValueRef.current = displayValue;
                } else {
                    peakIsVisibleRef.current = false;
                }
            }

            peakMeterDisplayValueRef.current = displayValue;

            if (peakMeterRef.current) {
                peakMeterRef.current.style.transform = `scaleY(${displayValue})`;
            }

            if (peakHoldRef.current) {
                const containerHeight = peakMeterRef.current?.parentElement?.offsetHeight ?? 1;
                const markerY = containerHeight * (1 - heldPeakValueRef.current);
                const heldPeakDb = normalizedToDb(heldPeakValueRef.current, minDisplayDb, maxDisplayDb);
                const peakColor = getColorForDb(heldPeakDb);

                peakHoldRef.current.style.opacity = peakIsVisibleRef.current ? '1' : '0';
                peakHoldRef.current.style.transform = `translateY(${markerY}px)`;
                peakHoldRef.current.style.borderTopColor = peakColor;
            }

            animationFrameId = requestAnimationFrame(updatePeakMeter);
        };

        animationFrameId = requestAnimationFrame(updatePeakMeter);

        return () => {
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
        };
    }, [peakData]);

    return (
        <div className="h-full w-2">
            <div className="relative h-[calc(100%-95px)] w-[3px] overflow-hidden bg-zinc-800">
                <div
                    ref={peakHoldRef}
                    className="pointer-events-none absolute z-10 h-full w-full border-t-2 bg-none"
                    style={{ transform: 'translateY(100%)', borderTopColor: '#22c55e' }}
                />
                <div
                    ref={peakMeterRef}
                    className="peak-meter-bar absolute bottom-0 z-0 w-full origin-bottom bg-teal-800"
                    style={{ transform: 'scaleY(0)' }}
                />
            </div>
        </div>
    );
};