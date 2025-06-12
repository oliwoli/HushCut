// @/stores/clipStore.ts

import { create } from "zustand";
import { useCallback, useMemo } from 'react';
import deepEqual from 'fast-deep-equal';
import { useStoreWithEqualityFn } from "zustand/traditional";
import { DetectionParams } from '@/types';

// The SINGLE source of truth for default parameter values
export const defaultParameters = {
  threshold: -30,
  paddingLeft: 0.5,
  paddingRight: 0.5,
  minDuration: 0.5,
};

// Re-export the ClipParameters type for use in other files
export type ClipParameters = typeof defaultParameters;

// Export the main store interface
export interface ClipStore {
  parameters: Record<string, ClipParameters>;
  currentClipId: string | null;
  setCurrentClipId: (clipId: string | null) => void;
  getParameter: <K extends keyof ClipParameters>(clipId: string, key: K) => ClipParameters[K];
  setParameter: <K extends keyof ClipParameters>(clipId: string, key: K, value: ClipParameters[K]) => void;
  setAllParameters: (clipId: string, newParams: Partial<ClipParameters>) => void;
  resetThreshold: (clipId: string) => void;
}

const getClipParams = (state: ClipStore, clipId: string) => 
    state.parameters[clipId] ?? defaultParameters;

export const useClipStore = create<ClipStore>((set, get) => ({
  parameters: {},
  currentClipId: null,

  setCurrentClipId: (clipId) => set({ currentClipId: clipId }),

  getParameter: (clipId, key) => getClipParams(get(), clipId)[key],

  setParameter: (clipId, key, value) =>
    set((state) => ({
      parameters: {
        ...state.parameters,
        [clipId]: {
          ...getClipParams(state, clipId),
          [key]: value,
        },
      },
    })),
  
  setAllParameters: (clipId, newParams) =>
    set((state) => ({
      parameters: {
        ...state.parameters,
        [clipId]: {
          ...getClipParams(state, clipId),
          ...newParams,
        },
      },
    })),

  resetThreshold: (clipId) =>
    set((state) => ({
      parameters: {
        ...state.parameters,
        [clipId]: {
          ...getClipParams(state, clipId),
          threshold: defaultParameters.threshold,
        },
      },
    })),
}));

/**
 * A hook to get and set a single parameter for a specific clip.
 */
export function useClipParameter<K extends keyof ClipParameters>(
    clipId: string,
    key: K
  ): [ClipParameters[K], (value: ClipParameters[K]) => void] {
    const value = useClipStore(s => getClipParams(s, clipId)[key]);
    const setParameter = useClipStore(s => s.setParameter);

    const set = useCallback((val: ClipParameters[K]) => {
      setParameter(clipId, key, val)
    }, [clipId, key, setParameter]);
  
    return [value, set];
}

// You can keep this hook here or move it. For now, we'll leave it out
// to keep this file focused on the core store logic.