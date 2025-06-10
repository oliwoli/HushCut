import { useState, useEffect, useMemo } from 'react';
import deepEqual from 'fast-deep-equal';
import { DetectionParams } from '@/types';

const DEFAULT_THRESHOLD = -30;
const DEFAULT_MIN_DURATION = 1.0;
const MIN_DURATION_LIMIT = 0.01;
const DEFAULT_PADDING = 0.25;

export const getDefaultDetectionParams = (): DetectionParams => ({
  loudnessThreshold: DEFAULT_THRESHOLD,
  minSilenceDurationSeconds: DEFAULT_MIN_DURATION,
  paddingLeftSeconds: DEFAULT_PADDING,
  paddingRightSeconds: DEFAULT_PADDING,
});

export function useClipParameters(activeClipId: string | null) {
  const [allClipParams, setAllClipParams] = useState<Record<string, DetectionParams>>({});
  
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [minDuration, setMinDuration] = useState(DEFAULT_MIN_DURATION);
  const [paddingLeft, setPaddingLeft] = useState(DEFAULT_PADDING);
  const [paddingRight, setPaddingRight] = useState(DEFAULT_PADDING);
  const [paddingLocked, setPaddingLinked] = useState(true);

  // Load params when active clip changes
  useEffect(() => {
    if (activeClipId) {
      const savedParams = allClipParams[activeClipId];
      if (savedParams) {
        setThreshold(savedParams.loudnessThreshold);
        setMinDuration(savedParams.minSilenceDurationSeconds);
        setPaddingLeft(savedParams.paddingLeftSeconds);
        setPaddingRight(savedParams.paddingRightSeconds);
      } else {
        // Reset to default for a new clip
        setThreshold(DEFAULT_THRESHOLD);
        setMinDuration(DEFAULT_MIN_DURATION);
        setPaddingLeft(DEFAULT_PADDING);
        setPaddingRight(DEFAULT_PADDING);
        setPaddingLinked(true);
      }
    }
  }, [activeClipId]);

  // Save params when they change for the active clip
  useEffect(() => {
    if (activeClipId) {
      const newParams: DetectionParams = {
        loudnessThreshold: threshold,
        minSilenceDurationSeconds: minDuration,
        paddingLeftSeconds: paddingLeft,
        paddingRightSeconds: paddingRight,
      };

      if (!deepEqual(allClipParams[activeClipId], newParams)) {
        setAllClipParams(prev => ({
          ...prev,
          [activeClipId]: newParams,
        }));
      }
    }
  }, [threshold, minDuration, paddingLeft, paddingRight, activeClipId, allClipParams]);

  const handlePaddingChange = (side: 'left' | 'right', value: number) => {
    const clampedValue = Math.max(0, value);
    if (paddingLocked) {
      setPaddingLeft(clampedValue);
      setPaddingRight(clampedValue);
    } else {
      side === 'left' ? setPaddingLeft(clampedValue) : setPaddingRight(clampedValue);
    }
  };
  
  const effectiveParams = useMemo<DetectionParams>(() => {
    if (activeClipId && allClipParams[activeClipId]) {
      return allClipParams[activeClipId];
    }
    return getDefaultDetectionParams();
  }, [activeClipId, allClipParams]);

  return {
    // State values
    threshold,
    minDuration,
    paddingLeft,
    paddingRight,
    paddingLocked,

    // Setters
    setThreshold,
    setMinDuration,
    handlePaddingChange,
    setPaddingLinked,
    
    // Derived state and data
    allClipParams,
    effectiveParams,

    // Reset functions
    resetThreshold: () => setThreshold(DEFAULT_THRESHOLD),
    resetMinDuration: () => setMinDuration(DEFAULT_MIN_DURATION),
    resetPadding: () => {
      setPaddingLeft(DEFAULT_PADDING);
      setPaddingRight(DEFAULT_PADDING);
      setPaddingLinked(true);
    },
  };
}