// useClipControls.ts

// REMOVED: All the duplicate store definitions.

// ADDED: Imports from your centralized store file.
import {
  useClipStore,
  defaultParameters,
  ClipParameters, // Import type if needed elsewhere
} from "@/stores/clipStore";

import { useState, useCallback, useMemo } from 'react';
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import deepEqual from 'fast-deep-equal';
import { DetectionParams } from '@/types';

/**
 * A comprehensive hook to control clip parameters for a UI panel.
 */
export function useClipControls() {
  // This code now correctly uses the SINGLE, SHARED store.
  const allParameters = useStoreWithEqualityFn(
    useClipStore,
    (state) => state.parameters,
    deepEqual
  );
  
  const { currentClipId, setParameter, setAllParameters } = useStoreWithEqualityFn(
    useClipStore,
    (state) => ({
      currentClipId: state.currentClipId,
      setParameter: state.setParameter,
      setAllParameters: state.setAllParameters,
    }),
    shallow
  );

  const activeClipParams = useStoreWithEqualityFn(
    useClipStore,
    (state) => (currentClipId ? state.parameters[currentClipId] : undefined),
    deepEqual
  );

  // The rest of your hook logic can remain exactly the same.
  // It will now correctly reference the shared defaultParameters and the single store.
  const [paddingLocked, setPaddingLinked] = useState(true);

  const minDuration = activeClipParams?.minDuration ?? defaultParameters.minDuration;
  const paddingLeft = activeClipParams?.paddingLeft ?? defaultParameters.paddingLeft;
  const paddingRight = activeClipParams?.paddingRight ?? defaultParameters.paddingRight;

  const setMinDuration = useCallback((value: number) => {
    if(!currentClipId) return;
    setParameter(currentClipId, 'minDuration', Math.max(0.01, value));
  }, [currentClipId, setParameter]);

  const handlePaddingChange = useCallback((side: 'left' | 'right', value: number) => {
    if (!currentClipId) return;
    const clampedValue = Math.max(0, value);
    if (paddingLocked) {
      setAllParameters(currentClipId, { paddingLeft: clampedValue, paddingRight: clampedValue });
    } else {
      setParameter(currentClipId, side === 'left' ? 'paddingLeft' : 'paddingRight', clampedValue);
    }
  }, [currentClipId, paddingLocked, setParameter, setAllParameters]);
  
  const resetMinDuration = useCallback(() => {
    if (!currentClipId) return;
    setParameter(currentClipId, 'minDuration', defaultParameters.minDuration);
  }, [currentClipId, setParameter]);

  const resetPadding = useCallback(() => {
    if (!currentClipId) return;
    setAllParameters(currentClipId, {
      paddingLeft: defaultParameters.paddingLeft,
      paddingRight: defaultParameters.paddingRight,
    });
    setPaddingLinked(true);
  }, [currentClipId, setAllParameters]);
  
  const allClipDetectionParams = useMemo(() => {
    const detectionParams: Record<string, DetectionParams> = {};
    for (const clipId in allParameters) {
        const params = allParameters[clipId];
        detectionParams[clipId] = {
            loudnessThreshold: params.threshold,
            minSilenceDurationSeconds: params.minDuration,
            paddingLeftSeconds: params.paddingLeft,
            paddingRightSeconds: params.paddingRight,
            minContent: params.minContent,
        };
    }
    return detectionParams;
  }, [allParameters]);

  const currentClipEffectiveParams = useMemo<DetectionParams>(() => {
    const params = activeClipParams || defaultParameters;
    return {
      loudnessThreshold: params.threshold,
      minSilenceDurationSeconds: params.minDuration,
      minContent: params.minContent,
      paddingLeftSeconds: params.paddingLeft,
      paddingRightSeconds: params.paddingRight,
    };
  }, [activeClipParams]);

  return {
    minDuration,
    paddingLeft,
    paddingRight,
    paddingLocked,
    allClipDetectionParams,
    effectiveParams: currentClipEffectiveParams,
    setMinDuration,
    handlePaddingChange,
    setPaddingLinked,
    resetMinDuration,
    resetPadding,
  };
}
