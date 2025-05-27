// src/components/SilenceDataDisplay.tsx (or your existing audioprocessor.tsx, refactored)

import React from "react";
import type { ActiveFile, SilencePeriod } from "../../types";

interface SilenceDataLogProps {
  activeFile: ActiveFile | null; // For displaying the name, etc.
  silenceData: SilencePeriod[] | null;
  isLoading: boolean;
  error: string | null;
}

const SilenceDataLog: React.FC<SilenceDataLogProps> = ({
  activeFile,
  silenceData,
  isLoading,
  error,
}) => {
  // Initial checks moved to the parent or handled by hook's initial state
  if (!activeFile) {
    // Could be handled by parent not rendering this if no activeFile
    return <p>Please select an audio file.</p>;
  }

  if (isLoading) {
    return <p>Loading silence data for {activeFile.name}...</p>;
  }

  if (error) {
    return <p>Error: {error}</p>;
  }

  return (
    <div>
      <h3>Silence Data for {activeFile.name}</h3>
      {silenceData && silenceData.length > 0 ? (
        <ul>
          {silenceData.map((period, index) => (
            <li key={index}>
              Silence: {period.start.toFixed(3)}s - {period.end.toFixed(3)}s
              (Duration: {(period.end - period.start).toFixed(3)}s)
            </li>
          ))}
        </ul>
      ) : silenceData ? ( // silenceData is not null, but potentially empty
        <p>No silence detected with the current settings.</p>
      ) : (
        // This state (silenceData is null, not loading, no error) means params might be missing
        // or initial state before first fetch if inputs were initially null.
        // The hook now sets isLoading to false if not fetching due to null inputs.
        <p>Configure parameters to detect silence.</p>
      )}
    </div>
  );
};

export default SilenceDataLog;
