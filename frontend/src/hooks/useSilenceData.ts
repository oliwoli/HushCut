// src/hooks/useSilenceData.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { GetOrDetectSilencesWithCache } from '@wails/go/main/App';
import { useClipStore } from '@/stores/clipStore'; // Import the store hook
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import type { ActiveClip, DetectionParams, SilencePeriod, SilenceDataHookResult } from '../types';


export function useSilenceData(
  activeFile: ActiveClip | null,
  timelineFps: number | null,
  debounceMs: number = 125,
): SilenceDataHookResult {
  const [silenceData, setSilenceData] = useState<SilencePeriod[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clipId = activeFile?.id ?? '';
  const detectionParams: DetectionParams | null = useStoreWithEqualityFn(
    useClipStore,
    (s) => {
      if (!clipId) return null;
      const correctParams = s.parameters[clipId] ?? s.liveDefaultParameters;
      // This is safe because useStoreWithEqualityFn with `shallow` is efficient
      return {
        loudnessThreshold: correctParams.threshold,
        minSilenceDurationSeconds: correctParams.minDuration,
        paddingLeftSeconds: correctParams.paddingLeft,
        paddingRightSeconds: correctParams.paddingRight,
        minContent: correctParams.minContent,
      };
    },
    shallow
  );

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const fetchLogic = useCallback(async () => {
    // Ensure all required parameters are present and valid
    if (!activeFile || !detectionParams || !timelineFps || timelineFps <= 0) {
      if (isMounted.current) {
        setSilenceData(null);
        setError(null); // Clear error if conditions are not met for fetching
        setIsLoading(false);
      }
      return;
    }

    // Also check if source frame numbers are valid; they should be numbers.
    // The ActiveClip type should enforce this, but an extra check doesn't hurt.
    if (typeof activeFile.sourceStartFrame !== 'number' || typeof activeFile.sourceEndFrame !== 'number') {
        console.warn("useSilenceData: Invalid sourceStartFrame or sourceEndFrame in activeFile.", activeFile);
        if (isMounted.current) {
            setSilenceData(null);
            setError("Invalid clip frame data.");
            setIsLoading(false);
        }
        return;
    }
    
    if (isMounted.current) {
      setIsLoading(true);
      setError(null);
    }

    const clipStartSeconds = activeFile.sourceStartFrame / timelineFps;
    const clipEndSeconds = activeFile.sourceEndFrame / timelineFps;

    if (clipEndSeconds <= clipStartSeconds) {
      console.warn(
          `useSilenceData: Invalid segment for ${activeFile.name} - start ${clipStartSeconds.toFixed(3)}s, end ${clipEndSeconds.toFixed(3)}s. Not fetching silences.`
      );
      if(isMounted.current) {
          setSilenceData(null);
          setError("Invalid clip segment duration for silence detection.");
          setIsLoading(false);
      }
      return;
  }


    try {
      const result = await GetOrDetectSilencesWithCache(
        activeFile.processedFileName,
        detectionParams.loudnessThreshold,
        detectionParams.minSilenceDurationSeconds,
        detectionParams.paddingLeftSeconds,
        detectionParams.paddingRightSeconds,
        detectionParams.minContent,
        clipStartSeconds,
        clipEndSeconds,
        timelineFps
      );
      if (isMounted.current) {
        setSilenceData(result);
      }
    } catch (err: any) {
      console.error("useSilenceData: Failed to get silence data:", err);
      const errorMessage = typeof err === "string" ? err : err.message || "Unknown error";
      if (isMounted.current) {
        setError(errorMessage);
        setSilenceData(null);
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [activeFile, detectionParams, timelineFps]);

  const debouncedFetch = useDebouncedCallback(fetchLogic, debounceMs);

  useEffect(() => {
    // Trigger fetch if all necessary data is available
    if (activeFile && detectionParams && timelineFps && timelineFps > 0) {
      debouncedFetch();
    } else {
      // If conditions are not met, cancel any pending fetch and reset state
      debouncedFetch.cancel();
      if (isMounted.current) {
        setSilenceData(null);
        setError(null);
        setIsLoading(false);
      }
    }

    // Cleanup function to cancel debounced call on unmount or when dependencies change
    return () => {
      debouncedFetch.cancel();
    };
  }, [activeFile, detectionParams, timelineFps, debouncedFetch]); // Added timelineFps to dependency array

  const refetch = useCallback(() => {
    debouncedFetch.cancel(); // Cancel any pending debounced call
    return fetchLogic();    // Call fetchLogic directly
  }, [fetchLogic, debouncedFetch]);
  //console.log("silence data: ", silenceData);
  //console.log("active file: ", activeFile);
  //console.log("detection params: ", detectionParams)
  return { silenceData, isLoading, error, refetch };
}