// @/stores/clipStore.ts

import { create } from "zustand";
import { useCallback, useMemo } from 'react';
import deepEqual from 'fast-deep-equal';
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { main } from "@wails/go/models";
import type { TimecodeInstance } from "smpte-timecode";


interface PlaybackState {
  currentTime: number;
  isPlaying: boolean;
}

// We don't need explicit setters; `setState` can update parts of the state.
export const usePlaybackStore = create<PlaybackState>(() => ({
  currentTime: 0,
  isPlaying: false,
}));


interface GlobalStore {
  makeNewTimeline: boolean;
  isThresholdDragging: boolean;
  keepSilence: boolean;
  skipSilences: boolean;
  setMakeNewTimeline: (value: boolean) => void;
  setIsThresholdDragging: (value: boolean) => void;
  setKeepSilence: (value: boolean) => void;
  setSkipSilences: (value: boolean) => void;
}

export const useGlobalStore = create<GlobalStore>((set) => ({
  makeNewTimeline: true,
  isThresholdDragging: false,
  keepSilence: false,
  skipSilences: true,
  setMakeNewTimeline: (value) => set({ makeNewTimeline: value }),
  setIsThresholdDragging: (value) => set({ isThresholdDragging: value }),
  setKeepSilence: (value) => set({ keepSilence: value}),
  setSkipSilences: (value) => set({ skipSilences: value }),
}));

interface TimecodeStore {
  timecode: TimecodeInstance | null;
  setTimecode: (value: TimecodeInstance | null) => void;
}

export const useTimecodeStore = create<TimecodeStore>((set) => ({
  timecode: null,
  setTimecode: (value) => set({ timecode: value }),
}));

interface ProjectDataStore {
  projectData: main.ProjectDataPayload | null;
  setProjectData: (value: main.ProjectDataPayload | null) => void;
}

export const useTProjectDataStore = create<ProjectDataStore>((set) => ({
  projectData: null,
  setProjectData: (value) => set({ projectData: value }),
}));


// The SINGLE source of truth for default parameter values
export const defaultParameters = {
  threshold: -30,
  minDuration: 0.5,
  paddingLeft: 0.05,
  paddingRight: 0.05,
  minContent: 0.1,
  paddingLocked: true,
  bypassed: false
};

export interface ClipParameters {
  threshold: number;
  minDuration: number;
  paddingLeft: number;
  paddingRight: number;
  minContent: number;
  paddingLocked: boolean;
  bypassed: boolean;
}

// Export the main store interface
export interface ClipStore {
  parameters: Record<string, ClipParameters>;
  clipToGroup: Record<string, string>;
  groupToClips: Record<string, string[]>;
  timelineItems: Record<string, main.TimelineItem>;
  currentClipId: string | null;
  groupActiveView: Record<string, string>;

  liveDefaultParameters: ClipParameters;
  // This is the setting to enable/disable the feature.
  syncDefaultsToLastEdit: boolean;

  setCurrentClipId: (clipId: string | null) => void;
  setClipToGroupMapping: (
    mapping: Record<string, string>,
    reverseMapping?: Record<string, string[]>,
    itemsMap?: Record<string, main.TimelineItem>
  ) => void;
  clearClipOverrides: (clipIds: string[]) => void;
  resetParameterToDefault: (clipId: string, key: keyof ClipParameters) => void;
  resetAllParametersToDefault: (clipId: string) => void;
  getParameter: <K extends keyof ClipParameters>(clipId: string, key: K) => ClipParameters[K];
  setParameter: <K extends keyof ClipParameters>(clipId: string, key: K, value: ClipParameters[K]) => void;
  setAllParameters: (clipId: string, newParams: Partial<ClipParameters>) => void;
  setSyncDefaults: (enabled: boolean) => void;
}

export const getClipParams = (state: ClipStore, clipId: string): ClipParameters => {
  if (state.parameters[clipId]) {
    return state.parameters[clipId];
  }
  const groupKey = state.clipToGroup?.[clipId];
  if (groupKey && state.parameters[groupKey]) {
    return {
      ...state.parameters[groupKey],
      bypassed: false,
    };
  }
  return state.liveDefaultParameters;
};

const NUMERIC_PARAM_KEYS: (keyof ClipParameters)[] = [
  'threshold',
  'minDuration',
  'paddingLeft',
  'paddingRight',
  'minContent',
];

const clampParameter = (key: keyof ClipParameters, val: number): number => {
  const rounded = Math.round(val * 1000) / 1000;
  if (key === 'threshold') {
    return Math.max(-60, Math.min(0, rounded));
  }
  if (key === 'minDuration') {
    return Math.max(0, Math.min(2, rounded));
  }
  return Math.max(0, Math.min(1, rounded));
};

export const useClipStore = create<ClipStore>((set, get) => ({
  currentClipId: null,
  groupActiveView: {},
  parameters: {},
  clipToGroup: {},
  groupToClips: {},
  timelineItems: {},

  liveDefaultParameters: { ...defaultParameters }, // Start with the hardcoded defaults

  syncDefaultsToLastEdit: true, // The feature is ON by default

  setCurrentClipId: (clipId) =>
    set((state) => {
      if (!clipId) {
        return { currentClipId: null };
      }
      if (state.groupToClips?.[clipId]) {
        return {
          currentClipId: clipId,
          groupActiveView: { ...state.groupActiveView, [clipId]: clipId },
        };
      }
      const parentGroupId = state.clipToGroup?.[clipId];
      if (parentGroupId) {
        return {
          currentClipId: clipId,
          groupActiveView: { ...state.groupActiveView, [parentGroupId]: clipId },
        };
      }
      return { currentClipId: clipId };
    }),
  setClipToGroupMapping: (mapping, reverseMapping, itemsMap) =>
    set((state) => ({
      clipToGroup: mapping,
      groupToClips: reverseMapping ?? {},
      timelineItems: itemsMap ?? state.timelineItems,
    })),
  clearClipOverrides: (clipIds) => {
    set((state) => {
      const newParams = { ...state.parameters };
      for (const id of clipIds) {
        delete newParams[id];
      }
      return { parameters: newParams };
    });
  },
  resetParameterToDefault: (clipId, key) => {
    set((state) => {
      const constituents = state.groupToClips?.[clipId];
      const defVal = defaultParameters[key];
      const newParams = { ...state.parameters };

      if (constituents && constituents.length > 0) {
        const groupParams = { ...getClipParams(state, clipId), [key]: defVal };
        if (key === 'paddingLeft' || key === 'paddingRight') {
          groupParams.paddingLeft = defaultParameters.paddingLeft;
          groupParams.paddingRight = defaultParameters.paddingRight;
        }
        newParams[clipId] = groupParams;

        for (const cid of constituents) {
          if (newParams[cid]) {
            const cur = { ...newParams[cid], [key]: defVal };
            if (key === 'paddingLeft' || key === 'paddingRight') {
              cur.paddingLeft = defaultParameters.paddingLeft;
              cur.paddingRight = defaultParameters.paddingRight;
            }
            const hasOtherDifferences = (Object.keys(cur) as (keyof ClipParameters)[]).some(
              (k) => k !== 'paddingLocked' && cur[k] !== groupParams[k]
            );
            if (!hasOtherDifferences && !cur.bypassed) {
              delete newParams[cid];
            } else {
              newParams[cid] = cur;
            }
          }
        }
        const newLiveDefaults = state.syncDefaultsToLastEdit
          ? {
              ...state.liveDefaultParameters,
              [key]: defVal,
              ...(key === 'paddingLeft' || key === 'paddingRight'
                ? {
                    paddingLeft: defaultParameters.paddingLeft,
                    paddingRight: defaultParameters.paddingRight,
                  }
                : {}),
            }
          : state.liveDefaultParameters;
        return { parameters: newParams, liveDefaultParameters: newLiveDefaults };
      }

      const parentGroupId = state.clipToGroup?.[clipId];
      const newLiveDefaults =
        state.syncDefaultsToLastEdit && !parentGroupId
          ? {
              ...state.liveDefaultParameters,
              [key]: defVal,
              ...(key === 'paddingLeft' || key === 'paddingRight'
                ? {
                    paddingLeft: defaultParameters.paddingLeft,
                    paddingRight: defaultParameters.paddingRight,
                  }
                : {}),
            }
          : state.liveDefaultParameters;

      const baseParams =
        parentGroupId && newParams[parentGroupId]
          ? newParams[parentGroupId]
          : newLiveDefaults;

      const cur = { ...getClipParams(state, clipId), [key]: defVal };
      if (key === 'paddingLeft' || key === 'paddingRight') {
        cur.paddingLeft = defaultParameters.paddingLeft;
        cur.paddingRight = defaultParameters.paddingRight;
      }
      const hasOtherDifferences =
        NUMERIC_PARAM_KEYS.some((k) => cur[k] !== baseParams[k]) ||
        cur.paddingLocked !== baseParams.paddingLocked;

      if (!hasOtherDifferences && !cur.bypassed) {
        delete newParams[clipId];
      } else {
        newParams[clipId] = cur;
      }

      return {
        parameters: newParams,
        liveDefaultParameters: newLiveDefaults,
      };
    });
  },
  resetAllParametersToDefault: (clipId) => {
    set((state) => {
      const constituents = state.groupToClips?.[clipId];
      const newParams = { ...state.parameters };

      if (constituents && constituents.length > 0) {
        const groupBypassed = Boolean(state.parameters[clipId]?.bypassed);
        const newLiveDefaults = state.syncDefaultsToLastEdit
          ? { ...defaultParameters, bypassed: state.liveDefaultParameters.bypassed }
          : state.liveDefaultParameters;

        const hasDiffFromLive =
          NUMERIC_PARAM_KEYS.some((k) => defaultParameters[k] !== newLiveDefaults[k]) ||
          defaultParameters.paddingLocked !== newLiveDefaults.paddingLocked;

        if (!hasDiffFromLive && !groupBypassed) {
          delete newParams[clipId];
        } else {
          newParams[clipId] = {
            ...defaultParameters,
            bypassed: groupBypassed,
          };
        }

        for (const cid of constituents) {
          if (newParams[cid]?.bypassed) {
            newParams[cid] = {
              ...defaultParameters,
              bypassed: true,
            };
          } else {
            delete newParams[cid];
          }
        }

        return {
          parameters: newParams,
          liveDefaultParameters: newLiveDefaults,
        };
      }

      const parentGroupId = state.clipToGroup?.[clipId];
      const clipBypassed = Boolean(getClipParams(state, clipId).bypassed);
      const resetClipParams: ClipParameters = {
        ...defaultParameters,
        bypassed: clipBypassed,
      };

      const newLiveDefaults =
        state.syncDefaultsToLastEdit && !parentGroupId
          ? { ...defaultParameters, bypassed: state.liveDefaultParameters.bypassed }
          : state.liveDefaultParameters;

      const baseParams =
        parentGroupId && newParams[parentGroupId]
          ? newParams[parentGroupId]
          : newLiveDefaults;

      const hasDiffFromBase =
        NUMERIC_PARAM_KEYS.some((k) => resetClipParams[k] !== baseParams[k]) ||
        resetClipParams.paddingLocked !== baseParams.paddingLocked;

      if (!hasDiffFromBase && !clipBypassed) {
        delete newParams[clipId];
      } else {
        newParams[clipId] = resetClipParams;
      }

      return {
        parameters: newParams,
        liveDefaultParameters: newLiveDefaults,
      };
    });
  },
  setSyncDefaults: (enabled) => set({ syncDefaultsToLastEdit: enabled }),
  getParameter: (clipId, key) => {
    const state = get();
    const constituents = state.groupToClips?.[clipId];
    if (constituents && constituents.length > 0) {
      if (key === 'bypassed' || key === 'paddingLocked') {
        return getClipParams(state, clipId)[key];
      }
      const activeConstituents = constituents.filter((cid) => !getClipParams(state, cid).bypassed);
      const targetConstituents = activeConstituents.length > 0 ? activeConstituents : constituents;

      let sum = 0;
      for (const cid of targetConstituents) {
        const cVal = getClipParams(state, cid)[key];
        sum += (cVal as number);
      }
      const avg = sum / targetConstituents.length;
      return (Math.round(avg * 1000) / 1000) as any;
    }
    return getClipParams(state, clipId)[key];
  },

  setParameter: (clipId, key, value) => {
    set((state) => {
      const constituents = state.groupToClips?.[clipId];
      if (constituents && constituents.length > 0) {
        if (key === 'bypassed' || key === 'paddingLocked') {
          const newParams = { ...state.parameters };
          const groupParams = {
            ...getClipParams(state, clipId),
            [key]: value,
          };
          newParams[clipId] = groupParams;
          return {
            parameters: newParams,
            liveDefaultParameters:
              state.syncDefaultsToLastEdit && key !== 'bypassed'
                ? { ...groupParams, bypassed: state.liveDefaultParameters.bypassed }
                : state.liveDefaultParameters,
          };
        }

        const activeConstituents = constituents.filter((cid) => !getClipParams(state, cid).bypassed);
        const targetConstituents = activeConstituents.length > 0 ? activeConstituents : constituents;

        // Numeric parameter offset adjustment across active group constituents:
        let sum = 0;
        for (const cid of targetConstituents) {
          const cVal = getClipParams(state, cid)[key];
          sum += (cVal as number);
        }
        const currentAvg = sum / targetConstituents.length;
        const delta = (value as number) - currentAvg;
        if (Math.abs(delta) < 1e-6) {
          return state;
        }

        const newParams = { ...state.parameters };
        const currentGroupVal = (getClipParams(state, clipId)[key] as number);
        const groupParams = {
          ...getClipParams(state, clipId),
          [key]: clampParameter(key, currentGroupVal + delta),
        };
        if (groupParams.paddingLocked && (key === 'paddingLeft' || key === 'paddingRight')) {
          const otherSide = key === 'paddingLeft' ? 'paddingRight' : 'paddingLeft';
          const otherVal = (getClipParams(state, clipId)[otherSide] as number);
          groupParams[otherSide] = clampParameter(otherSide, otherVal + delta);
        }
        newParams[clipId] = groupParams;

        // Shift active constituents that have explicit overrides in state.parameters
        for (const cid of targetConstituents) {
          if (newParams[cid]) {
            const cur = { ...newParams[cid] };
            const oldVal = cur[key] as number;
            cur[key] = clampParameter(key, oldVal + delta) as any;
            if (cur.paddingLocked && (key === 'paddingLeft' || key === 'paddingRight')) {
              const otherSide = key === 'paddingLeft' ? 'paddingRight' : 'paddingLeft';
              const oldOther = cur[otherSide] as number;
              cur[otherSide] = clampParameter(otherSide, oldOther + delta) as any;
            }
            newParams[cid] = cur;
          }
        }

        return {
          parameters: newParams,
          liveDefaultParameters: state.syncDefaultsToLastEdit
            ? { ...state.liveDefaultParameters, [key]: clampParameter(key, value as number) }
            : state.liveDefaultParameters,
        };
      }

      const currentValue = getClipParams(state, clipId)[key];
      if (currentValue === value) {
        return state;
      }

      const newClipParams = {
        ...getClipParams(state, clipId),
        [key]: value,
      };

      const shouldUpdateLiveDefaults =
        state.syncDefaultsToLastEdit && key !== 'bypassed' && !state.clipToGroup?.[clipId];

      return {
        parameters: {
          ...state.parameters,
          [clipId]: newClipParams,
        },
        liveDefaultParameters: shouldUpdateLiveDefaults
          ? { ...newClipParams, bypassed: state.liveDefaultParameters.bypassed }
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

      const shouldUpdateLiveDefaults = state.syncDefaultsToLastEdit;

      return {
        parameters: {
          ...state.parameters,
          [clipId]: newClipParams,
        },
        liveDefaultParameters: shouldUpdateLiveDefaults
          ? { ...newClipParams, bypassed: state.liveDefaultParameters.bypassed }
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

export function useIsClipModified(clipIdToCheck?: string): boolean {
  return useStoreWithEqualityFn(
    useClipStore,
    (state) => {
      const clipId = clipIdToCheck ?? state.currentClipId;
      if (!clipId) return false;

      // A clip can't be "modified" if it doesn't have its own specific parameters.
      // This is the crucial first check.
      if (!Object.prototype.hasOwnProperty.call(state.parameters, clipId)) {
        return false;
      }

      // The clip has its own parameters, so let's get them.
      const clipParams = state.parameters[clipId];
      const staticDefaults = defaultParameters;

      // Now, we check if any of the clip's OWN parameters (excluding 'bypassed')
      // have a value that is different from the static, hardcoded default.
      return (Object.keys(clipParams) as (keyof ClipParameters)[]).some(key => {
        if (key === 'bypassed') {
          return false; // Always ignore the 'bypassed' key in the comparison.
        }
        // If the clip's value for this key is different from the default,
        // then the clip is considered modified.
        return clipParams[key] !== staticDefaults[key];
      });
    }
  );
}

export function useHasGroupOverrides(constituentIds?: string[]): boolean {
  return useStoreWithEqualityFn(
    useClipStore,
    (state) => {
      if (!constituentIds || constituentIds.length === 0) return false;
      return constituentIds.some((id) =>
        isConstituentClipOverridden(id, state.parameters, state.clipToGroup)
      );
    }
  );
}

export function isConstituentClipOverridden(
  clipId: string,
  parameters: Record<string, ClipParameters>,
  clipToGroup?: Record<string, string>
): boolean {
  const clipParams = parameters[clipId];
  if (!clipParams) return false;
  const groupMap = clipToGroup ?? useClipStore.getState().clipToGroup;
  const groupId = groupMap?.[clipId];
  const baseParams = groupId && parameters[groupId] ? parameters[groupId] : defaultParameters;
  return NUMERIC_PARAM_KEYS.some((k) => clipParams[k] !== baseParams[k]);
}

