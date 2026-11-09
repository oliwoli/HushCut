import type { main } from "./models-adapter";
import type { ActiveClip, DetectionParams, RegionModification, SilencePeriod } from "../types";
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
  a: SilencePeriod[],
  b: SilencePeriod[]
): SilencePeriod[] {
  const result: SilencePeriod[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const itemA = a[i];
    const itemB = b[j];
    const start = Math.max(itemA.start, itemB.start);
    const end = Math.min(itemA.end, itemB.end);
    if (end > start + 1e-4) {
      const hasMeta =
        itemA.rawStart !== undefined ||
        itemB.rawStart !== undefined ||
        itemA.isModified !== undefined ||
        itemB.isModified !== undefined;

      if (!hasMeta) {
        result.push({ start, end });
      } else {
        const leftFromA = itemA.start >= itemB.start;
        const rightFromA = itemA.end <= itemB.end;
        const rawStart = Math.max(itemA.rawStart ?? itemA.start, itemB.rawStart ?? itemB.start);
        const rawEnd = Math.min(itemA.rawEnd ?? itemA.end, itemB.rawEnd ?? itemB.end);
        const baseStart = Math.max(itemA.baseStart ?? itemA.start, itemB.baseStart ?? itemB.start);
        const baseEnd = Math.min(itemA.baseEnd ?? itemA.end, itemB.baseEnd ?? itemB.end);
        const mid = (rawStart + rawEnd) / 2;

        const startModified = Boolean(leftFromA ? itemA.startModified : itemB.startModified);
        const endModified = Boolean(rightFromA ? itemA.endModified : itemB.endModified);
        const modIds: string[] = [];
        for (const id of [...(itemA.modificationIds ?? []), ...(itemB.modificationIds ?? [])]) {
          if (!modIds.includes(id)) modIds.push(id);
        }

        result.push({
          start,
          end,
          rawStart,
          rawEnd,
          baseStart,
          baseEnd,
          startCenterTime: leftFromA ? (itemA.startCenterTime ?? mid) : (itemB.startCenterTime ?? mid),
          endCenterTime: rightFromA ? (itemA.endCenterTime ?? mid) : (itemB.endCenterTime ?? mid),
          startModId: leftFromA ? itemA.startModId : itemB.startModId,
          endModId: rightFromA ? itemA.endModId : itemB.endModId,
          startModified,
          endModified,
          isModified: startModified || endModified,
          modificationIds: modIds,
        });
      }
    }
    if (itemA.end < itemB.end) {
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
  lists: SilencePeriod[][]
): SilencePeriod[] {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0];
  let current = lists[0];
  for (let k = 1; k < lists.length; k++) {
    current = intersectTwoSilenceLists(current, lists[k]);
    if (current.length === 0) break;
  }
  return current;
}

export const REGION_MODIFICATION_EPSILON_SECONDS = 0.75;
export const MODIFICATION_DELTA_EPSILON = 1e-4;

/**
 * postProcessSilencesWithModifications takes raw (unpadded, unmerged) silence intervals,
 * matches any manual region modifications by midpoint timecode within an epsilon leeway,
 * and applies padding, minimum silence duration filtering, and silence merge (minContent).
 *
 * When two or more regions merge due to minContent:
 * - The merged region's start comes from the leftmost region; it inherits startModified only if the leftmost region had its start modified.
 * - The merged region's end comes from the rightmost region; it inherits endModified only if the rightmost region had its end modified.
 * - The merged region is marked `isModified = startModified || endModified`.
 */
export function postProcessSilencesWithModifications(
  rawSilences: Array<{ start: number; end: number }>,
  params: {
    minSilenceDurationSeconds: number;
    paddingLeftSeconds: number;
    paddingRightSeconds: number;
    minContent: number;
  },
  clipStartSeconds: number,
  clipEndSeconds: number,
  modifications?: RegionModification[],
  midpointEpsilon: number = REGION_MODIFICATION_EPSILON_SECONDS
): SilencePeriod[] {
  const epsilon = 0.001;
  const minDur = Math.max(0.009, params.minSilenceDurationSeconds);
  const { paddingLeftSeconds, paddingRightSeconds, minContent } = params;

  // 1. Match modifications to raw silences by midpoint timecode
  const matchedModByRawIdx = new Map<number, RegionModification>();
  if (modifications && modifications.length > 0 && rawSilences.length > 0) {
    const usedRawIndices = new Set<number>();
    for (const mod of modifications) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < rawSilences.length; i++) {
        if (usedRawIndices.has(i)) continue;
        const r = rawSilences[i];
        const mid = (r.start + r.end) / 2;
        const dist = Math.abs(mid - mod.centerTime);
        const insideBounds =
          mod.centerTime >= r.start - midpointEpsilon &&
          mod.centerTime <= r.end + midpointEpsilon;
        if (dist <= midpointEpsilon || insideBounds) {
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
      }
      if (bestIdx !== -1) {
        usedRawIndices.add(bestIdx);
        matchedModByRawIdx.set(bestIdx, mod);
      }
    }
  }

  // 2. Apply deltas, padding, and minSilenceDuration filtering
  const preliminary: SilencePeriod[] = [];
  for (let i = 0; i < rawSilences.length; i++) {
    const raw = rawSilences[i];
    const mod = matchedModByRawIdx.get(i);

    const deltaStart = mod ? mod.deltaStart : 0;
    const deltaEnd = mod ? mod.deltaEnd : 0;
    const startMod = Boolean(mod && Math.abs(mod.deltaStart) > MODIFICATION_DELTA_EPSILON);
    const endMod = Boolean(mod && Math.abs(mod.deltaEnd) > MODIFICATION_DELTA_EPSILON);

    // Base padded boundaries (matches Go's DetectSilences padding logic)
    const baseStart = raw.start > clipStartSeconds + epsilon ? raw.start + paddingLeftSeconds : raw.start;
    const baseEnd = raw.end < clipEndSeconds - epsilon ? raw.end - paddingRightSeconds : raw.end;

    const adjustedStart = Math.max(baseStart + deltaStart, clipStartSeconds);
    const adjustedEnd = Math.min(baseEnd + deltaEnd, clipEndSeconds);
    const centerTime = (raw.start + raw.end) / 2;

    if (adjustedEnd - adjustedStart >= minDur) {
      preliminary.push({
        start: adjustedStart,
        end: adjustedEnd,
        rawStart: raw.start,
        rawEnd: raw.end,
        baseStart,
        baseEnd,
        startCenterTime: centerTime,
        endCenterTime: centerTime,
        startModId: mod?.id,
        endModId: mod?.id,
        startModified: startMod,
        endModified: endMod,
        isModified: startMod || endMod,
        modificationIds: mod && (startMod || endMod) ? [mod.id] : [],
      });
    }
  }

  if (preliminary.length === 0) {
    return [];
  }

  // 3. Snap first/last silence to clip boundaries if content at boundary is shorter than minContent
  const first = preliminary[0];
  if (
    first.start - clipStartSeconds > epsilon &&
    first.start - clipStartSeconds < minContent
  ) {
    first.start = clipStartSeconds;
  }
  const last = preliminary[preliminary.length - 1];
  if (
    clipEndSeconds - last.end > epsilon &&
    clipEndSeconds - last.end < minContent
  ) {
    last.end = clipEndSeconds;
  }

  // 4. Silence Merge (minContent) with directional modification inheritance
  const merged: SilencePeriod[] = [];
  let current: SilencePeriod = { ...preliminary[0] };

  for (let i = 1; i < preliminary.length; i++) {
    const next = preliminary[i];
    const contentDuration = next.start - current.end;
    if (contentDuration < minContent) {
      // Merging `current` (left) with `next` (right):
      // - Keep `current.start` and `current.startModified` (left side modification)
      // - Adopt `next.end` and `next.endModified` (right side modification)
      const inheritedStartMod = Boolean(current.startModified);
      const inheritedEndMod = Boolean(next.endModified);
      const inheritedIsMod = inheritedStartMod || inheritedEndMod;

      const modIds: string[] = [];
      if (inheritedStartMod && current.modificationIds) {
        for (const id of current.modificationIds) {
          if (!modIds.includes(id)) modIds.push(id);
        }
      }
      if (inheritedEndMod && next.modificationIds) {
        for (const id of next.modificationIds) {
          if (!modIds.includes(id)) modIds.push(id);
        }
      }

      current = {
        start: current.start,
        end: next.end,
        rawStart: current.rawStart,
        rawEnd: next.rawEnd,
        baseStart: current.baseStart,
        baseEnd: next.baseEnd,
        startCenterTime: current.startCenterTime,
        endCenterTime: next.endCenterTime,
        startModId: current.startModId,
        endModId: next.endModId,
        startModified: inheritedStartMod,
        endModified: inheritedEndMod,
        isModified: inheritedIsMod,
        modificationIds: modIds,
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}


