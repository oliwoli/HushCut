import type { main } from "./models-adapter";
import type { ActiveClip, DetectionParams } from "../types";
import type { ClipStore } from "../stores/clipStore";

export interface DisplayClip {
  id: string; // Unique ID, e.g. "linkgroup_1" for linked groups, or item.id for single items
  name: string;
  start_frame: number;
  end_frame: number;
  duration: number;
  source_start_frame: number;
  source_end_frame: number;
  processed_file_name: string;
  source_file_path: string;
  track_indices: number[];
  track_label: string; // e.g. "A1, A2" or "A1"
  link_group_id: number | null;
  is_linked_group: boolean; // TRUE only if multi-audio link group!
  constituent_item_ids: string[];
  constituent_processed_file_names?: string[];
  type?: string;
  primary_item: main.TimelineItem;
}

/**
 * formatTrackIndices formats a slice of track numbers into a readable label.
 * e.g. [1] => "A1"
 * e.g. [1, 2] => "A1, A2"
 * e.g. [1, 2, 3] => "A1–A3"
 */
export function formatTrackIndices(tracks: number[]): string {
  if (!tracks || tracks.length === 0) return "";
  const sorted = [...new Set(tracks)].sort((a, b) => a - b);
  const isConsecutive =
    sorted.length >= 3 &&
    sorted.every((t, i) => i === 0 || t === sorted[i - 1] + 1);

  if (isConsecutive) {
    return `A${sorted[0]}–A${sorted[sorted.length - 1]}`;
  }
  return sorted.map((t) => `A${t}`).join(", ");
}

/**
 * buildDisplayClips transforms raw audio items and linked audio groups into a unified list
 * of DisplayClips. Linked clips with 2 or more audio items are collapsed into a single combined
 * entry whose waveform and audio playback correspond to the combined mixdown.
 * Single audio clips (even if linked to video) remain individual items without the link icon.
 */
export function buildDisplayClips(
  audioItems: main.TimelineItem[] | null | undefined,
  linkedAudioGroups?: { [_ in string]?: main.LinkedAudioGroup | null } | null
): DisplayClip[] {
  if (!audioItems || audioItems.length === 0) return [];

  // Sort raw items chronologically
  const sortedRaw = [...audioItems].sort((a, b) => {
    if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
    if (a.track_index !== b.track_index) return a.track_index - b.track_index;
    return a.end_frame - b.end_frame;
  });

  const displayClips: DisplayClip[] = [];
  const processedGroupIds = new Set<number>();

  for (const item of sortedRaw) {
    const groupId = item.link_group_id;
    // Look up group in linkedAudioGroups (handling numeric or string keys)
    const group =
      groupId != null && linkedAudioGroups
        ? (linkedAudioGroups[groupId as any] ||
           linkedAudioGroups[String(groupId) as any])
        : null;

    if (groupId != null && group) {
      if (processedGroupIds.has(groupId)) {
        continue; // Already processed this linked group
      }
      processedGroupIds.add(groupId);

      // Collect all constituent items for this group
      const constituentItems = sortedRaw.filter(
        (it) => it.link_group_id === groupId
      );
      const constituentIds =
        group.item_ids && group.item_ids.length > 0
          ? group.item_ids
          : constituentItems.map((it) => it.id);
      const constituentFileNames = constituentItems
        .map((it) => it.processed_file_name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);

      const primaryItem = constituentItems[0] || item;
      const cleanName = primaryItem.name || `Linked Audio (Group ${groupId})`;

      const tracks =
        group.track_indices && group.track_indices.length > 0
          ? group.track_indices
          : constituentItems.map((it) => it.track_index);

      displayClips.push({
        id: `linkgroup_${groupId}`,
        name: cleanName,
        start_frame: group.start_frame,
        end_frame: group.end_frame,
        duration: group.duration,
        source_start_frame: 0,
        source_end_frame: group.duration,
        processed_file_name: group.processed_file_name,
        source_file_path: primaryItem.source_file_path || "",
        track_indices: tracks,
        track_label: formatTrackIndices(tracks),
        link_group_id: groupId,
        is_linked_group: true,
        constituent_item_ids: constituentIds,
        constituent_processed_file_names: constituentFileNames,
        type: constituentItems.find((it) => it.type)?.type,
        primary_item: primaryItem,
      });
    } else {
      // Single item (unlinked, or linked with only 1 audio item)
      displayClips.push({
        id: item.id || item.processed_file_name || "",
        name: item.name || "Unnamed Track Item",
        start_frame: item.start_frame,
        end_frame: item.end_frame,
        duration: item.duration,
        source_start_frame: item.source_start_frame,
        source_end_frame: item.source_end_frame,
        processed_file_name: item.processed_file_name || "",
        source_file_path: item.source_file_path || "",
        track_indices: [item.track_index],
        track_label: `A${item.track_index}`,
        link_group_id: item.link_group_id ?? null,
        is_linked_group: false,
        constituent_item_ids: [item.id],
        constituent_processed_file_names: item.processed_file_name ? [item.processed_file_name] : [],
        type: item.type,
        primary_item: item,
      });
    }
  }

  // Final sort by timeline start frame
  displayClips.sort((a, b) => {
    if (a.start_frame !== b.start_frame) return a.start_frame - b.start_frame;
    const aTrack = a.track_indices[0] ?? 0;
    const bTrack = b.track_indices[0] ?? 0;
    if (aTrack !== bTrack) return aTrack - bTrack;
    return a.end_frame - b.end_frame;
  });

  return displayClips;
}

export function createActiveFileFromDisplayClip(
  clip: DisplayClip,
  port: number,
  fps: number
): ActiveClip | null {
  if (!clip.processed_file_name) {
    return null;
  }
  const clipStartSeconds = clip.source_start_frame / fps;
  const clipEndSeconds = clip.source_end_frame / fps;

  return {
    id: clip.id,
    name: clip.name || "Unnamed Track Item",
    sourceFilePath: clip.source_file_path,
    processedFileName: clip.processed_file_name,
    previewUrl: `http://localhost:${port}/render_clip?file=${encodeURIComponent(
      clip.processed_file_name
    )}&start=${clipStartSeconds}&end=${clipEndSeconds}`,
    sourceStartFrame: clip.source_start_frame,
    sourceEndFrame: clip.source_end_frame,
    startFrame: clip.start_frame,
    duration: clip.duration,
  };
}

export function createActiveFileFromTimelineItem(
  item: main.TimelineItem,
  port: number,
  fps: number
): ActiveClip | null {
  if (!item.processed_file_name) {
    return null;
  }
  const clipStartSeconds = item.source_start_frame / fps;
  const clipEndSeconds = item.source_end_frame / fps;

  return {
    id: item.id,
    name: item.name || "Unnamed Track Item",
    sourceFilePath: item.source_file_path,
    processedFileName: item.processed_file_name,
    previewUrl: `http://localhost:${port}/render_clip?file=${encodeURIComponent(
      item.processed_file_name
    )}&start=${clipStartSeconds}&end=${clipEndSeconds}`,
    sourceStartFrame: item.source_start_frame,
    sourceEndFrame: item.source_end_frame,
    startFrame: item.start_frame,
    duration: item.duration,
  };
}

/**
 * deriveAllClipDetectionParams extracts silence detection parameters for all timeline items.
 * If an item is part of a multi-audio link group:
 * - If the group as a whole is bypassed, all its items are excluded.
 * - If a specific item is bypassed in local view, that item is excluded.
 * - If a specific item has per-clip parameter overrides in local view, those overrides are used.
 * - Otherwise, parameters configured for that group take precedence over live defaults.
 */
export function deriveAllClipDetectionParams(
  timelineItems: main.TimelineItem[],
  clipStoreState: ClipStore
): Record<string, DetectionParams> {
  const detectionParams: Record<string, DetectionParams> = {};

  for (const item of timelineItems) {
    const clipId = item.id;
    if (!clipId) continue;

    const groupKey = item.link_group_id != null ? `linkgroup_${item.link_group_id}` : undefined;
    const groupParams = groupKey ? clipStoreState.parameters[groupKey] : undefined;
    const itemParams = clipStoreState.parameters[clipId];

    // 1. If the group as a whole is bypassed, bypass all its clips
    if (groupParams?.bypassed) {
      continue;
    }

    // 2. If this specific constituent clip is bypassed in local view, bypass it
    if (itemParams?.bypassed) {
      continue;
    }

    // 3. Parameters priority: Local View per-clip override -> Group parameters -> Live defaults
    const correctClipParams = itemParams ?? groupParams ?? clipStoreState.liveDefaultParameters;

    if (correctClipParams.bypassed) {
      continue;
    }

    detectionParams[clipId] = {
      loudnessThreshold: correctClipParams.threshold,
      minSilenceDurationSeconds: correctClipParams.minDuration,
      minContent: correctClipParams.minContent,
      paddingLeftSeconds: correctClipParams.paddingLeft,
      paddingRightSeconds: correctClipParams.paddingRight,
    };
  }
  return detectionParams;
}

/**
 * Computes the intersection of two disjoint, sorted silence period lists.
 */
export function intersectTwoSilenceLists(
  a: Array<{ start: number; end: number }>,
  b: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start + 1e-4) {
      result.push({ start, end });
    }
    if (a[i].end < b[j].end) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

/**
 * Computes the multi-way intersection across multiple silence period lists.
 */
export function intersectMultipleSilenceLists(
  lists: Array<Array<{ start: number; end: number }>>
): Array<{ start: number; end: number }> {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0];
  let current = lists[0];
  for (let k = 1; k < lists.length; k++) {
    current = intersectTwoSilenceLists(current, lists[k]);
    if (current.length === 0) break;
  }
  return current;
}

