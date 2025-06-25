// stores/appSync.ts
import { create } from 'zustand';

type SyncBusyState = {
  isBusy: boolean;
  setBusy: (value: boolean) => void;
};

export const useSyncBusyState = create<SyncBusyState>((set) => ({
  isBusy: false, // default value
  setBusy: (value) => set({ isBusy: value }),
}));
