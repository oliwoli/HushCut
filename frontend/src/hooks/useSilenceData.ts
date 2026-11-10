// src/hooks/useSilenceData.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import { GetOrDetectSilencesWithCache } from '@wails/go/main/App';
import { useClipStore, getClipParams } from '@/stores/clipStore';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import deepEqual from 'fast-deep-equal';
import { intersectMultipleSilenceLists, postProcessSilencesWithModifications } from '@/lib/clipUtils';
import type { ActiveClip, DetectionParams, RegionModification, SilencePeriod, SilenceDataHookResult } from '../types';

interface ConstituentTarget {
  id: string;
  bypassed: boolean;
  params: DetectionParams;
  modifications: RegionModification[];
}

interface SilenceDetectionTarget {
  clipId: string;
  isGroup: boolean;
  groupBypassed: boolean;
  groupParams?: DetectionParams;
  groupModifications?: RegionModification[];
  singleBypassed?: boolean;
  singleParams?: DetectionParams;
  singleModifications?: RegionModification[];
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
          groupParams: {
            loudnessThreshold: s.getParameter(clipId, 'threshold'),
            minSilenceDurationSeconds: s.getParameter(clipId, 'minDuration'),
            paddingLeftSeconds: s.getParameter(clipId, 'paddingLeft'),
            paddingRightSeconds: s.getParameter(clipId, 'paddingRight'),
            minContent: s.getParameter(clipId, 'minContent'),
          },
          groupModifications: s.regionModifications[clipId] ?? [],
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
              modifications: s.regionModifications[cid] ?? [],
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
        singleModifications: s.regionModifications[clipId] ?? [],
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
        const rawSilences = await GetOrDetectSilencesWithCache(
          activeFile.processedFileName,
          p.loudnessThreshold,
          0.009,
          0,
          0,
          0,
          clipStartSeconds,
          clipEndSeconds,
          timelineFps
        );
        const result = postProcessSilencesWithModifications(
          rawSilences,
          p,
          clipStartSeconds,
          clipEndSeconds,
          detectionTarget.singleModifications
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
    const groupMods = detectionTarget.groupModifications ?? [];
    const gp = detectionTarget.groupParams;

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
          const shift = -clipStartSeconds + offsetSeconds;

          if (clipEndSeconds <= clipStartSeconds) {
            return [];
          }

          try {
            const rawSilences = await GetOrDetectSilencesWithCache(
              fileName,
              c.params.loudnessThreshold,
              0.009,
              0,
              0,
              0,
              clipStartSeconds,
              clipEndSeconds,
              timelineFps
            );

            const effectiveParams =
              groupMods.length > 0 && gp
                ? {
                    minSilenceDurationSeconds: Math.max(
                      0.009,
                      c.params.minSilenceDurationSeconds - gp.minSilenceDurationSeconds
                    ),
                    paddingLeftSeconds: Math.max(
                      0,
                      c.params.paddingLeftSeconds - gp.paddingLeftSeconds
                    ),
                    paddingRightSeconds: Math.max(
                      0,
                      c.params.paddingRightSeconds - gp.paddingRightSeconds
                    ),
                    minContent: Math.max(0, c.params.minContent - gp.minContent),
                  }
                : c.params;

            const processed = postProcessSilencesWithModifications(
              rawSilences,
              effectiveParams,
              clipStartSeconds,
              clipEndSeconds,
              c.modifications
            );

            // Map from constituent source time domain to group timeline time domain:
            const mapped: SilencePeriod[] = [];
            for (const s of processed) {
              const sStart = s.start + shift;
              const sEnd = s.end + shift;
              const clampedStart = Math.max(0, sStart);
              const clampedEnd = Math.min(groupDurationSeconds, sEnd);
              if (clampedEnd > clampedStart + 1e-4) {
                const rawStart = Math.max(0, (s.rawStart ?? s.start) + shift);
                const rawEnd = Math.min(groupDurationSeconds, (s.rawEnd ?? s.end) + shift);
                const baseStart = Math.max(0, (s.baseStart ?? s.start) + shift);
                const baseEnd = Math.min(groupDurationSeconds, (s.baseEnd ?? s.end) + shift);
                const mid = (rawStart + rawEnd) / 2;
                mapped.push({
                  ...s,
                  start: clampedStart,
                  end: clampedEnd,
                  rawStart,
                  rawEnd,
                  baseStart,
                  baseEnd,
                  startCenterTime: s.startCenterTime !== undefined ? s.startCenterTime + shift : mid,
                  endCenterTime: s.endCenterTime !== undefined ? s.endCenterTime + shift : mid,
                });
              }
            }
            return mapped;
          } catch (itemErr) {
            console.error(`useSilenceData: Failed to detect silences for constituent ${c.id}:`, itemErr);
            return [];
          }
        })
      );

      let intersected = intersectMultipleSilenceLists(constituentSilenceLists);
      if (groupMods.length > 0 && gp) {
        intersected = postProcessSilencesWithModifications(
          intersected,
          gp,
          0,
          groupDurationSeconds,
          groupMods
        );
      }

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
