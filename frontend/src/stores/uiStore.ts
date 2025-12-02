import { create } from 'zustand';

interface UiState {
  isInfoDialogOpen: boolean;
  setInfoDialogOpen: (isOpen: boolean) => void;
  isSettingsDialogOpen: boolean;
  setSettingsDialogOpen: (isOpen: boolean) => void;
  uiScale: number;
  setUiScale: (uiScale: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  isInfoDialogOpen: false,
  setInfoDialogOpen: (isOpen) => set({ isInfoDialogOpen: isOpen }),
  isSettingsDialogOpen: false,
  setSettingsDialogOpen: (isOpen) => set({ isSettingsDialogOpen: isOpen }),
  uiScale: 1.0,
  setUiScale: (value) => set({ uiScale: value})
}));