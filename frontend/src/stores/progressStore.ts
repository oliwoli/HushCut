import { create } from 'zustand';
import { EventsOn } from '@wails/runtime/runtime';

// Helper to generate the same unique key for a waveform job
const generateWaveformJobKey = (fileName: string, start: number, end: number): string => {
  return `${fileName}|${start.toFixed(3)}|${end.toFixed(3)}`;
};

// Helper to get the base filename from a path
const getFileName = (fullPath: string): string => {
  if (!fullPath) return '';
  return fullPath.split(/[\\/]/).pop() || '';
};

interface ProgressState {
  conversionProgress: Record<string, number>;
  waveformProgress: Record<string, number>;
  conversionErrors: Record<string, boolean>;
  // This function will initialize the event listeners
  initialize: () => () => void; // Returns a cleanup function
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  conversionProgress: {},
  waveformProgress: {},
  conversionErrors: {},
  
  initialize: () => {
    const unsubs = [
      EventsOn('conversion:progress', (e: { filePath: string; percentage: number }) => {
        const fileName = getFileName(e.filePath);
        if (fileName) {
          set(state => ({
            conversionProgress: { ...state.conversionProgress, [fileName]: e.percentage }
          }));
        }
      }),

      EventsOn('conversion:done', (e: { filePath: string }) => {
        const fileName = getFileName(e.filePath);
        if (fileName) {
          set(state => ({
            conversionProgress: { ...state.conversionProgress, [fileName]: 100 }
          }));
          // Optional: Clear the 'done' status after a delay
          setTimeout(() => {
            set(state => {
              const { [fileName]: _, ...rest } = state.conversionProgress;
              const { [fileName]: __, ...restErrors } = state.conversionErrors;
              return { conversionProgress: rest, conversionErrors: restErrors };
            });
          }, 1000);
        }
      }),
      
      EventsOn('conversion:error', (e: { filePath: string }) => {
        const fileName = getFileName(e.filePath);
        if (fileName) {
          set(state => ({
            conversionErrors: { ...state.conversionErrors, [fileName]: true }
          }));
        }
      }),

      EventsOn('waveform:progress', (e: { filePath: string; clipStart: number; clipEnd: number; percentage: number }) => {
        const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
        set(state => ({
          waveformProgress: { ...state.waveformProgress, [jobKey]: e.percentage }
        }));
      }),

      EventsOn('waveform:done', (e: { filePath: string; clipStart: number; clipEnd: number; }) => {
        const jobKey = generateWaveformJobKey(e.filePath, e.clipStart, e.clipEnd);
        set(state => {
          const { [jobKey]: _, ...rest } = state.waveformProgress;
          return { waveformProgress: rest };
        });
      })
    ];
    
    // Return a function that calls all unsubscribe functions
    return () => unsubs.forEach(unsub => unsub());
  }
}));

// Initialize listeners once in a top-level component (like your main App component)
// This avoids setting up listeners multiple times.
let isInitialized = false;
export const initializeProgressListeners = () => {
    if(!isInitialized) {
        useProgressStore.getState().initialize();
        isInitialized = true;
    }
}