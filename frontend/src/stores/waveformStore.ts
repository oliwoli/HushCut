import { create } from 'zustand';
import { main } from "@wails/go/models";

interface WaveformState {
  cutAudioSegmentUrl: string | undefined;
  peakData: main.PrecomputedWaveformData | null;
  setWaveform: (url: string | undefined, data: main.PrecomputedWaveformData | null) => void;
}

export const useWaveformStore = create<WaveformState>((set) => ({
  cutAudioSegmentUrl: undefined,
  peakData: null,
  setWaveform: (url, data) => set({ cutAudioSegmentUrl: url, peakData: data }),
}));
