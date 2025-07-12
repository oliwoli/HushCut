
export interface SilencePeriod {
  start: number;
  end: number;
}

export interface ActiveClip {
  id: string;                   // Unique identifier (e.g., TimelineItem.ID or ProcessedFileName if unique)
  name: string;                 // Display name for the selector (TimelineItem.Name)
  sourceFilePath: string;       // Full path to the source file (TimelineItem.SourceFilePath)
  processedFileName: string;    // Base for the preview URL (TimelineItem.ProcessedFileName)
  previewUrl: string;           // Full URL to the .wav file
  sourceStartFrame: number;     // For WaveformPlayer region (TimelineItem.SourceStartFrame)
  sourceEndFrame: number;       // For WaveformPlayer region (TimelineItem.SourceEndFrame)
  startFrame: number;
  duration: number;          // Duration of the clip in frames
  // Optional: Store original timeline item data if needed elsewhere for convenience
  // trackIndex: number;
  // timelineStartFrame: number; // To distinguish from sourceStartFrame for other uses
}

export interface DetectionParams {
  loudnessThreshold: number;
  minSilenceDurationSeconds: number;
  paddingLeftSeconds: number;
  paddingRightSeconds: number;
  minContent: number;
}

export interface SilenceDataHookResult {
  silenceData: SilencePeriod[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>; // Function to manually trigger a refetch
}