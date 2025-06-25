// src/stores/uiStore.ts

import { create } from 'zustand';

interface UiState {
  isInfoDialogOpen: boolean;
  setInfoDialogOpen: (isOpen: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  isInfoDialogOpen: false,
  setInfoDialogOpen: (isOpen) => set({ isInfoDialogOpen: isOpen }),
}));