// ./components/ui/fileSelector.tsx
import React from "react";
import { cn } from "@/lib/utils"; // Or your path to cn
import { main } from "@wails/go/models"; // Assuming this is how you import Wails models

interface FileSelectorProps {
  audioItems: main.TimelineItem[] | null | undefined;
  currentFileId: string | null; // This ID will match ActiveFile.id
  onFileChange: (selectedItemId: string) => void; // Pass back a unique ID of the TimelineItem
  disabled?: boolean;
  className?: string;
}

const FileSelector: React.FC<FileSelectorProps> = ({
  audioItems,
  currentFileId,
  onFileChange,
  disabled,
  className,
}) => {
  const getSortedAudioItems = () => {
    if (!audioItems || audioItems.length === 0) return [];
    // Create a copy before sorting to avoid mutating the prop
    return [...audioItems].sort((a, b) => {
      // Wails models might use PascalCase for properties matching Go struct fields
      // Adjust a.TrackIndex, a.StartFrame etc. if your TS models use different casing
      if (a.track_index !== b.track_index) {
        return a.track_index - b.track_index;
      }
      if (a.start_frame !== b.start_frame) {
        return a.start_frame - b.start_frame;
      }
      return a.end_frame - b.end_frame;
    });
  };

  const sortedItems = getSortedAudioItems();

  if (sortedItems.length === 0) {
    return (
      <select
        disabled={true}
        className={cn(
          "bg-zinc-700 border border-zinc-600 text-zinc-400 text-sm rounded-lg block w-full p-2.5 cursor-not-allowed",
          className
        )}
      >
        <option>No audio items in timeline</option>
      </select>
    );
  }

  return (
    <select
      value={currentFileId || ""}
      onChange={(e) => onFileChange(e.target.value)}
      disabled={disabled || sortedItems.length === 0}
      className={cn(
        "text-black text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5",
        className
      )}
    >
      <option
        value=""
        disabled={!!currentFileId && currentFileId !== "initial-preview"}
      >
        -- Select an audio track item --
      </option>
      {sortedItems.map((item) => {
        // IMPORTANT: Use a reliably unique identifier from the item for 'key' and 'value'.
        // item.ID is a good candidate if it's populated from DaVinci.
        // Otherwise, item.ProcessedFileName could work if unique.
        const itemUniqueIdentifier = item.id || item.processed_file_name;
        if (!itemUniqueIdentifier) {
          console.warn(
            "TimelineItem is missing a unique identifier (ID or ProcessedFileName):",
            item
          );
          return null; // Skip rendering this item if it has no identifier
        }
        return (
          <option key={itemUniqueIdentifier} value={itemUniqueIdentifier}>
            {item.name} {/* Display name from TimelineItem.Name */}
          </option>
        );
      })}
    </select>
  );
};

export default FileSelector;
