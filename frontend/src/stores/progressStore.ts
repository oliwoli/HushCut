import { create } from 'zustand';
import { EventsOn } from '@wails/runtime/runtime';

const getFileName = (fullPath: string): string => {
  if (!fullPath) return '';
  return fullPath.split(/[\\/]/).pop() || '';
};

const generateWaveformJobKey = (fileName: string, start: number, end: number): string => {
  return `${fileName}|${start.toFixed(3)}|${end.toFixed(3)}`;
};

interface ProgressState {
  conversionProgress: Record<string, number>;
  waveformProgress: Record<string, number>;
  conversionErrors: Record<string, boolean>;
}

export const useProgressStore = create<ProgressState>()(() => ({
  conversionProgress: {},
  waveformProgress: {},
  conversionErrors: {},
}));

// This function should be called ONCE when your app starts.
export function initializeProgressListeners() {
  EventsOn('conversion:progress', (e: { filePath: string; percentage: number }) => {
    const fileName = getFileName(e.filePath);
    if (fileName) {
      useProgressStore.setState(state => ({
        conversionProgress: { ...state.conversionProgress, [fileName]: e.percentage }
      }));
    }
  });

  EventsOn('conversion:done', (e: { filePath: string }) => {
    const fileName = getFileName(e.filePath);
    if (fileName) {
      useProgressStore.setState(state => ({
        conversionProgress: { ...state.conversionProgress, [fileName]: 100 }
      }));
      setTimeout(() => {
        useProgressStore.setState(state => {
          const { [fileName]: _, ...rest } = state.conversionProgress;
          return { conversionProgress: rest };
        });
      }, 1000);
    }
  });

  EventsOn('conversion:error', (e: { filePath: string }) => {
    const fileName = getFileName(e.filePath);
    if (fileName) {
      useProgressStore.setState(state => ({
        conversionErrors: { ...state.conversionErrors, [fileName]: true }
      }));
    }
  });
  
  EventsOn('waveform:progress', (e: { filePath: string; clipStart: number; clipEnd: number; percentage: number }) => {
    const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
    useProgressStore.setState(state => ({
      waveformProgress: { ...state.waveformProgress, [jobKey]: e.percentage }
    }));
  });

  EventsOn('waveform:done', (e: { filePath: string; clipStart: number; clipEnd: number; }) => {
    const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
    useProgressStore.setState(state => {
      const { [jobKey]: _, ...rest } = state.waveformProgress;
      return { waveformProgress: rest };
    });
  });
}