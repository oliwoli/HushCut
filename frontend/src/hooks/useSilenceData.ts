// src/hooks/useSilenceData.ts (or a similar path)

import { useState, useEffect, useCallback } from 'react';
// Make sure this path is correct for your project structure
import { GetOrDetectSilencesWithCache } from '../../wailsjs/go/main/App';
import type { ActiveFile, DetectionParams, SilencePeriod, SilenceDataHookResult } from '../types'; // Adjust path to types.ts

export function useSilenceData(
  activeFile: ActiveFile | null,
  detectionParams: DetectionParams | null
): SilenceDataHookResult {
  const [silenceData, setSilenceData] = useState<SilencePeriod[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSilenceData = useCallback(async () => {
    if (!activeFile || !detectionParams) {
      setSilenceData(null);
      setError(null);
      setIsLoading(false); // Important to set loading to false if not fetching
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const result = await GetOrDetectSilencesWithCache(
        activeFile.path,
        detectionParams.loudnessThreshold,
        detectionParams.minSilenceDurationSeconds,
        detectionParams.paddingLeftSeconds,
        detectionParams.paddingRightSeconds
      );
      setSilenceData(result);
    } catch (err: any) {
      console.error("Failed to get silence data from Go backend:", err);
      const errorMessage =
        typeof err === "string"
          ? err
          : err.message || "An unknown error occurred while processing audio.";
      setError(errorMessage);
      setSilenceData(null);
    } finally {
      setIsLoading(false);
    }
  }, [activeFile, detectionParams]);

  useEffect(() => {
    // Fetch data when activeFile or detectionParams change
    fetchSilenceData();
  }, [fetchSilenceData]); // fetchSilenceData is memoized and includes activeFile & detectionParams in its deps

  return { silenceData, isLoading, error, refetch: fetchSilenceData };
}