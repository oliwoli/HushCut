// stores/appSync.ts
import { create } from 'zustand';

type AppState = {
  syncing: boolean;
  setSyncing: (value: boolean) => void;
  isBusy: boolean;
  setBusy: (value: boolean) => void;
  hasProjectData: boolean;
  setHasProjectData: (value: boolean) => void;
  timelineName: string | null;
  setTimelineName: (value: string | null) => void;
  token: string | null;
  setToken: (value: string | null) => void;
};

export const useAppState = create<AppState>((set) => ({
  isBusy: false, // default value
  setBusy: (value) => set({ isBusy: value }),
  syncing: false,
  setSyncing: (value) => set({ syncing: value }),
  hasProjectData: false, // default value
  setHasProjectData: (value) => set({ hasProjectData: value }),
  timelineName: "",
  setTimelineName: (value) => set({ timelineName: value}),
  token: "",
  setToken: (value) => set({ token: value})
}));
