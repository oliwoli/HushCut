// src/hooks/useSilenceData.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { GetOrDetectSilencesWithCache } from '@wails/go/main/App';
import { useClipStore, getClipParams } from '@/stores/clipStore';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import deepEqual from 'fast-deep-equal';
import { intersectMultipleSilenceLists } from '@/lib/clipUtils';
import type { ActiveClip, DetectionParams, SilencePeriod, SilenceDataHookResult } from '../types';

interface ConstituentTarget {
  id: string;
  bypassed: boolean;
  params: DetectionParams;
}

interface SilenceDetectionTarget {
  clipId: string;
  isGroup: boolean;
  groupBypassed: boolean;
  singleBypassed?: boolean;
  singleParams?: DetectionParams;
  constituents?: ConstituentTarget[];
}

export function useSilenceData(
  activeFile: ActiveClip | null,
  timelineFps: number | null,
  debounceMs: number = 90,
): SilenceDataHookResult {
  const [silenceData, setSilenceData] = useState<SilencePeriod[] | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clipId = activeFile?.id ?? '';

  const detectionTarget = useStoreWithEqualityFn(
    useClipStore,
    (s): SilenceDetectionTarget | null => {
      if (!clipId) return null;
      const constituents = s.groupToClips?.[clipId];
      const isGroup = Boolean(constituents && constituents.length > 0);
      const groupParams = getClipParams(s, clipId);

      if (isGroup && constituents) {
        return {
          clipId,
          isGroup: true,
          groupBypassed: Boolean(groupParams.bypassed),
          constituents: constituents.map((cid) => {
            const cp = getClipParams(s, cid);
            return {
              id: cid,
              bypassed: Boolean(cp.bypassed),
              params: {
                loudnessThreshold: cp.threshold,
                minSilenceDurationSeconds: cp.minDuration,
                paddingLeftSeconds: cp.paddingLeft,
                paddingRightSeconds: cp.paddingRight,
                minContent: cp.minContent,
              },
            };
          }),
        };
      }

      return {
        clipId,
        isGroup: false,
        groupBypassed: false,
        singleBypassed: Boolean(groupParams.bypassed),
        singleParams: {
          loudnessThreshold: groupParams.threshold,
          minSilenceDurationSeconds: groupParams.minDuration,
          paddingLeftSeconds: groupParams.paddingLeft,
          paddingRightSeconds: groupParams.paddingRight,
          minContent: groupParams.minContent,
        },
      };
    },
    deepEqual
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
    if (!activeFile || !detectionTarget || !timelineFps || timelineFps <= 0) {
      if (isMounted.current) {
        setSilenceData(null);
        setError(null);
        setIsLoading(false);
      }
      return;
    }

    if (
      typeof activeFile.sourceStartFrame !== 'number' ||
      typeof activeFile.sourceEndFrame !== 'number'
    ) {
      console.warn('useSilenceData: Invalid sourceStartFrame or sourceEndFrame in activeFile.', activeFile);
      if (isMounted.current) {
        setSilenceData(null);
        setError('Invalid clip frame data.');
        setIsLoading(false);
      }
      return;
    }

    if (isMounted.current) {
      setIsLoading(true);
      setError(null);
    }

    // 1. If group as a whole or single clip is explicitly bypassed, return empty silences
    if (detectionTarget.isGroup && detectionTarget.groupBypassed) {
      if (isMounted.current) {
        setSilenceData([]);
        setIsLoading(false);
      }
      return;
    }
    if (!detectionTarget.isGroup && detectionTarget.singleBypassed) {
      if (isMounted.current) {
        setSilenceData([]);
        setIsLoading(false);
      }
      return;
    }

    // 2. Single Clip processing
    if (!detectionTarget.isGroup) {
      const p = detectionTarget.singleParams;
      if (!p) {
        if (isMounted.current) setIsLoading(false);
        return;
      }
      const clipStartSeconds = activeFile.sourceStartFrame / timelineFps;
      const clipEndSeconds = activeFile.sourceEndFrame / timelineFps;

      if (clipEndSeconds <= clipStartSeconds) {
        if (isMounted.current) {
          setSilenceData(null);
          setError('Invalid clip segment duration for silence detection.');
          setIsLoading(false);
        }
        return;
      }

      try {
        const result = await GetOrDetectSilencesWithCache(
          activeFile.processedFileName,
          p.loudnessThreshold,
          p.minSilenceDurationSeconds,
          p.paddingLeftSeconds,
          p.paddingRightSeconds,
          p.minContent,
          clipStartSeconds,
          clipEndSeconds,
          timelineFps
        );
        if (isMounted.current) {
          setSilenceData(result);
        }
      } catch (err: any) {
        console.error('useSilenceData: Failed to get silence data:', err);
        const errorMessage = typeof err === 'string' ? err : err.message || 'Unknown error';
        if (isMounted.current) {
          setError(errorMessage);
          setSilenceData(null);
        }
      } finally {
        if (isMounted.current) {
          setIsLoading(false);
        }
      }
      return;
    }

    // 3. Linked Group processing:
    // Silences on the group are the intersection of all non-bypassed constituent clips' silences.
    const activeConstituents = (detectionTarget.constituents || []).filter((c) => !c.bypassed);
    if (activeConstituents.length === 0) {
      if (isMounted.current) {
        setSilenceData([]);
        setIsLoading(false);
      }
      return;
    }

    const itemsMap = useClipStore.getState().timelineItems;
    const groupMinStart = activeFile.startFrame;
    const groupDurationSeconds = activeFile.duration / timelineFps;

    try {
      const constituentSilenceLists = await Promise.all(
        activeConstituents.map(async (c) => {
          const item = itemsMap[c.id];
          const fileName = item?.processed_file_name || activeFile.processedFileName;
          const itemStartFrame = item?.start_frame ?? activeFile.startFrame;
          const sourceStartFrame = item?.source_start_frame ?? activeFile.sourceStartFrame;
          const sourceEndFrame = item?.source_end_frame ?? activeFile.sourceEndFrame;
          const clipStartSeconds = sourceStartFrame / timelineFps;
          const clipEndSeconds = sourceEndFrame / timelineFps;
          const offsetSeconds = (itemStartFrame - groupMinStart) / timelineFps;

          if (clipEndSeconds <= clipStartSeconds) {
            return [];
          }

          try {
            const rawSilences = await GetOrDetectSilencesWithCache(
              fileName,
              c.params.loudnessThreshold,
              c.params.minSilenceDurationSeconds,
              c.params.paddingLeftSeconds,
              c.params.paddingRightSeconds,
              c.params.minContent,
              clipStartSeconds,
              clipEndSeconds,
              timelineFps
            );

            // Map from constituent source time domain to group timeline time domain:
            const mapped: SilencePeriod[] = [];
            for (const s of rawSilences) {
              const sStart = s.start - clipStartSeconds + offsetSeconds;
              const sEnd = s.end - clipStartSeconds + offsetSeconds;
              const clampedStart = Math.max(0, sStart);
              const clampedEnd = Math.min(groupDurationSeconds, sEnd);
              if (clampedEnd > clampedStart + 1e-4) {
                mapped.push({ start: clampedStart, end: clampedEnd });
              }
            }
            return mapped;
          } catch (itemErr) {
            console.error(`useSilenceData: Failed to detect silences for constituent ${c.id}:`, itemErr);
            return [];
          }
        })
      );

      const intersected = intersectMultipleSilenceLists(constituentSilenceLists);
      if (isMounted.current) {
        setSilenceData(intersected);
      }
    } catch (err: any) {
      console.error('useSilenceData: Failed to calculate group silence intersection:', err);
      const errorMessage = typeof err === 'string' ? err : err.message || 'Unknown error';
      if (isMounted.current) {
        setError(errorMessage);
        setSilenceData(null);
      }
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [activeFile, detectionTarget, timelineFps]);

  const debouncedFetch = useDebouncedCallback(fetchLogic, debounceMs);

  useEffect(() => {
    if (activeFile && detectionTarget && timelineFps && timelineFps > 0) {
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
  }, [activeFile, detectionTarget, timelineFps, debouncedFetch]);

  const refetch = useCallback(() => {
    debouncedFetch.cancel();
    return fetchLogic();
  }, [fetchLogic, debouncedFetch]);

  return { silenceData, isLoading, error, refetch };
}
