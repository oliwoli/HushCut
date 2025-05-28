// src/hooks/useSilenceData.ts

import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebouncedCallback } from 'use-debounce';
// Make sure this path is correct for your project structure
import { GetOrDetectSilencesWithCache } from '../../wailsjs/go/main/App';
import type { ActiveFile, DetectionParams, SilencePeriod, SilenceDataHookResult } from '../types'; // Adjust path to types.ts

export function useSilenceData(
  activeFile: ActiveFile | null,
  detectionParams: DetectionParams | null,
  debounceMs: number = 150
): SilenceDataHookResult {
  const [silenceData, setSilenceData] = useState<SilencePeriod[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // fetchLogic is async, so it implicitly returns Promise<void>
  const fetchLogic = useCallback(async () => {
    if (!activeFile || !detectionParams) {
      if (isMounted.current) {
        setSilenceData(null);
        setError(null);
        setIsLoading(false);
      }
      return; // Implicitly Promise.resolve()
    }

    if (isMounted.current) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const result = await GetOrDetectSilencesWithCache(
        activeFile.path,
        detectionParams.loudnessThreshold,
        detectionParams.minSilenceDurationSeconds,
        detectionParams.paddingLeftSeconds,
        detectionParams.paddingRightSeconds
      );
      if (isMounted.current) {
        setSilenceData(result);
      }
    } catch (err: any) {
      console.error("Failed to get silence data from Go backend:", err);
      const errorMessage =
        typeof err === "string"
          ? err
          : err.message || "An unknown error occurred while processing audio.";
      if (isMounted.current) {
        setError(errorMessage);
        setSilenceData(null);
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [activeFile, detectionParams]);

  const debouncedFetch = useDebouncedCallback(fetchLogic, debounceMs);

  useEffect(() => {
    if (activeFile && detectionParams) {
      debouncedFetch();
    } else {
      debouncedFetch.cancel();
      if (isMounted.current) {
        setSilenceData(null);
        setError(null);
        setIsLoading(false);
      }
    }

    return () => {
      debouncedFetch.cancel();
    };
  }, [activeFile, detectionParams, debouncedFetch]);

  // Ensure refetch returns the Promise from fetchLogic
  const refetch = useCallback(() => {
    debouncedFetch.cancel();
    return fetchLogic(); // Return the promise from fetchLogic
  }, [fetchLogic, debouncedFetch]);

  return { silenceData, isLoading, error, refetch };
}