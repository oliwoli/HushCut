import { create } from 'zustand';

interface BusyState {
    isBusy: boolean;
    setIsBusy: (isBusy: boolean) => void;
}

export const useBusy = create<BusyState>((set) => ({
    isBusy: false,
    setIsBusy: (isBusy) => set({ isBusy }),
}));
