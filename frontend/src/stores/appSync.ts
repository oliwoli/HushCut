// stores/appSync.ts
import { create } from 'zustand';

type SyncBusyState = {
  isBusy: boolean;
  setBusy: (value: boolean) => void;
  hasProjectData: boolean;
  setHasProjectData: (value: boolean) => void;
  timelineName: string | null;
  setTimelineName: (value: string | null) => void;
};

export const useSyncBusyState = create<SyncBusyState>((set) => ({
  isBusy: false, // default value
  setBusy: (value) => set({ isBusy: value }),
  hasProjectData: false, // default value
  setHasProjectData: (value) => set({ hasProjectData: value }),
  timelineName: "",
  setTimelineName: (value) => set({ timelineName: value})
}));
