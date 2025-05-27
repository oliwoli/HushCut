
export interface SilencePeriod {
  start: number;
  end: number;
}

export interface ActiveFile {
  path: string;
  name: string;
}

export interface DetectionParams {
  loudnessThreshold: string;
  minSilenceDurationSeconds: string;
  paddingLeftSeconds: number;
  paddingRightSeconds: number;
}

export interface SilenceDataHookResult {
  silenceData: SilencePeriod[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>; // Function to manually trigger a refetch
}