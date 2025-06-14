// @/stores/clipStore.ts

import { create } from "zustand";
import { useCallback, useMemo } from 'react';
import deepEqual from 'fast-deep-equal';
import { useStoreWithEqualityFn } from "zustand/traditional";


interface GlobalStore {
  makeNewTimeline: boolean;
  setMakeNewTimeline: (value: boolean) => void;
}

export const useGlobalStore = create<GlobalStore>((set) => ({
  makeNewTimeline: false,
  setMakeNewTimeline: (value) => set({ makeNewTimeline: value }),
}));


// The SINGLE source of truth for default parameter values
export const defaultParameters = {
  threshold: -30,
  minDuration: 0.5,
  minContent: 0.5,
  paddingLeft: 0.5,
  paddingRight: 0.5,
};

export interface ClipParameters {
  threshold: number;
  minDuration: number;
  minContent: number;
  paddingLeft: number;
  paddingRight: number;
}

// Export the main store interface
export interface ClipStore {
  parameters: Record<string, ClipParameters>;
  currentClipId: string | null;

  liveDefaultParameters: ClipParameters;
  // This is the setting to enable/disable the feature.
  syncDefaultsToLastEdit: boolean;

  setCurrentClipId: (clipId: string | null) => void;
  getParameter: <K extends keyof ClipParameters>(clipId: string, key: K) => ClipParameters[K];
  setParameter: <K extends keyof ClipParameters>(clipId: string, key: K, value: ClipParameters[K]) => void;
  setAllParameters: (clipId: string, newParams: Partial<ClipParameters>) => void;
  setSyncDefaults: (enabled: boolean) => void;
}

const getClipParams = (state: ClipStore, clipId: string) => 
  state.parameters[clipId] ?? state.liveDefaultParameters;

export const useClipStore = create<ClipStore>((set, get) => ({
  currentClipId: null,
  parameters: {},

  liveDefaultParameters: { ...defaultParameters }, // Start with the hardcoded defaults

  syncDefaultsToLastEdit: true, // The feature is ON by default

  setCurrentClipId: (clipId) => set({ currentClipId: clipId }),
  setSyncDefaults: (enabled) => set({ syncDefaultsToLastEdit: enabled }),
  getParameter: (clipId, key) => getClipParams(get(), clipId)[key],


  setParameter: (clipId, key, value) => {
    const currentValue = getClipParams(get(), clipId)[key];
    if (currentValue === value) {
      return;
    }

    set((state) => {
      const newClipParams = {
        ...getClipParams(state, clipId),
        [key]: value,
      };
      
      // --- THIS IS THE FIX ---
      // We remove the `isFirstModification` check.
      // Now, as long as the setting is on, we ALWAYS update the live defaults.
      const shouldUpdateLiveDefaults = state.syncDefaultsToLastEdit;

      return {
        parameters: {
          ...state.parameters,
          [clipId]: newClipParams,
        },
        liveDefaultParameters: shouldUpdateLiveDefaults
          ? { ...newClipParams }
          : state.liveDefaultParameters,
      };
    });
  },
  
  setAllParameters: (clipId, newParams) => {
    const currentParams = getClipParams(get(), clipId);
    const hasChanged = Object.entries(newParams).some(
      ([key, value]) => currentParams[key as keyof ClipParameters] !== value
    );
    if (!hasChanged) {
      return;
    }

    set((state) => {
      const newClipParams = {
        ...getClipParams(state, clipId),
        ...newParams,
      };

      // --- THIS IS THE FIX (applied here too for consistency) ---
      const shouldUpdateLiveDefaults = state.syncDefaultsToLastEdit;

      return {
        parameters: {
          ...state.parameters,
          [clipId]: newClipParams,
        },
        liveDefaultParameters: shouldUpdateLiveDefaults
          ? { ...newClipParams }
          : state.liveDefaultParameters,
      };
    });
  },
}));


export function useClipParameter<K extends keyof ClipParameters>(
  key: K
): [ClipParameters[K], (value: ClipParameters[K]) => void] {
  const clipId = useClipStore(s => s.currentClipId);

  const selector = useCallback(
    (state: ClipStore) => {
      if (!clipId) return defaultParameters[key]; // Keep the fallback for when no clip is selected.
      
      // Use the store's public `getParameter` method, which correctly returns
      // either the clip's specific parameter or the live default.
      return state.getParameter(clipId, key);
    },
    [clipId, key]
  );

  const value = useStoreWithEqualityFn(useClipStore, selector, deepEqual);
  const { setParameter } = useClipStore.getState();

  const set = (val: ClipParameters[K]) => {
    if (!clipId) return;
    setParameter(clipId, key, val);
  };

  return [value, set];
}

export function useIsClipModified(): boolean {
  // --- THIS IS THE FIX ---
  // This new selector is more efficient. It returns a simple boolean.
  // React will only re-render if the boolean's value actually changes from true to false or vice-versa.
  // This prevents the re-render loop.
  const isModified = useStoreWithEqualityFn(
    useClipStore,
    (state) => {
      if (!state.currentClipId) {
        return false;
      }
      // Directly compute and return the boolean primitive.
      return Object.prototype.hasOwnProperty.call(state.parameters, state.currentClipId);
    }
    // We no longer need the `shallow` equality checker because the selector returns a primitive.
    // Zustand's default `Object.is` comparison is perfect for this.
  );

  return isModified;
}