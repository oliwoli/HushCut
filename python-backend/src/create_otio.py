import os
import opentimelineio as otio
from collections.abc import Mapping
import time
import json
import copy
import logging
from collections import defaultdict
from typing import (
    List,
    Dict,
    Optional,
    DefaultDict,
    Set,
    Tuple,
    TypedDict,
    Union,
)
from opentimelineio import schema as otio_schema

from local_types import ProjectData, EditInstruction, TimelineItem
#from pprint import pprint
# --- Logging Setup ---
logging.basicConfig(level=logging.ERROR, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

TrackItemType = Union[otio_schema.Clip, otio_schema.Gap, otio_schema.Transition]


class OriginalTimelineCatalog(TypedDict):
    ordered_items: List[
        Tuple[str, str, Optional[TrackItemType], otio.opentime.RationalTime]
    ]
    clips_by_group_and_track: DefaultDict[str, DefaultDict[int, otio_schema.Clip]]


class OtioTimelineData(TypedDict):
    timeline: otio_schema.Timeline
    rate: float
    global_start_offset_frames: float


EditInstructionsList = List[EditInstruction]
# Map uses item_key -> Instruction List (offset calculation moved into apply function)
GroupEditsMap = Dict[str, EditInstructionsList]

GroupSourceDataMap = Dict[str, List[Tuple[TimelineItem, EditInstructionsList]]]
# --- Helper Functions ---


def _get_max_original_link_group_id(original_timeline: otio_schema.Timeline) -> int:
    max_id = 0

    for track in original_timeline.tracks:
        for item in track:
            if not isinstance(item, otio_schema.Clip):
                continue

            resolve_otio_meta = item.metadata.get("Resolve_OTIO")
            if not isinstance(resolve_otio_meta, Mapping):
                continue

            link_id_val = resolve_otio_meta.get("Link Group ID")
            if not isinstance(link_id_val, int):
                continue

            max_id = max(max_id, link_id_val)

    return max_id


def _generate_otio_item_map_key(
    item: TrackItemType, track_idx_0_based: int, item_idx_in_track: int
) -> str:
    """Generates a consistent key for an OTIO item."""
    if isinstance(item, otio_schema.Gap):
        return f"gap_track{track_idx_0_based}_item{item_idx_in_track}"
    elif isinstance(item, otio_schema.Clip):
        link_id = item.metadata.get("Resolve_OTIO", {}).get("Link Group ID")
        if link_id is not None:
            return f"linkgroup_{link_id}"
        else:
            return f"unlinked_track{track_idx_0_based}_item{item_idx_in_track}"
    else:
        return f"unknown_track{track_idx_0_based}_item{item_idx_in_track}_{id(item)}"


def _derive_json_id_from_otio_clip(
    otio_clip: otio_schema.Clip,
    otio_track_kind_str: str,
    resolve_style_track_index: int,
    original_start_frame_int: int,
) -> str:
    """Constructs the candidate JSON ID to match main.py's format."""
    # Format: ClipName-TrackType-ResolveTrackIndex--TimelineStartFrame
    return f"{otio_clip.name}-{otio_track_kind_str}-{resolve_style_track_index}--{original_start_frame_int}"


# --- Core Logic Functions ---


def load_otio_timeline_data(otio_path: str) -> OtioTimelineData:
    # (Implementation is correct)
    timeline = otio.adapters.read_from_file(otio_path)
    rate = 0.0
    global_start_offset_frames = 0.0
    if timeline.global_start_time:
        rate = timeline.global_start_time.rate
        global_start_offset_frames = timeline.global_start_time.value
    else:
        for track in timeline.tracks:
            if item := next(
                (it for it in track if it.source_range and it.source_range.start_time),
                None,
            ):
                rate = item.source_range.start_time.rate
                break
        if rate == 0.0:
            raise ValueError(
                f"Could not determine frame rate for OTIO file: {otio_path}"
            )
        logger.warning(
            f"OTIO timeline '{timeline.name}' missing global_start_time. Inferred rate: {rate}. Assuming 0 global start offset."
        )
    return {
        "timeline": timeline,
        "rate": rate,
        "global_start_offset_frames": global_start_offset_frames,
    }


def load_project_data(json_path: str) -> ProjectData:
    # (Implementation is correct)
    with open(json_path, "r") as f:
        return json.load(f)


def _index_json_timeline_items(
    project_data: ProjectData,
) -> Dict[str, TimelineItem]:
    # (Implementation is correct)
    json_items_by_id: Dict[str, TimelineItem] = {}
    all_json_timeline_items: List[TimelineItem] = []
    timeline_data = project_data.get("timeline")
    if timeline_data:
        audio_items = timeline_data.get("audio_track_items")
        video_items = timeline_data.get("video_track_items")
        if audio_items:
            all_json_timeline_items.extend(audio_items)
        if video_items:
            all_json_timeline_items.extend(video_items)
    for item in all_json_timeline_items:
        json_item_id = item.get("id")
        item_edit_instructions = item.get("edit_instructions")
        if json_item_id and isinstance(item_edit_instructions, list):
            json_items_by_id[json_item_id] = item
    logger.debug(f"Indexed {len(json_items_by_id)} JSON items by their ID.")
    return json_items_by_id


def _map_otio_to_json_edits(
    original_otio_timeline: otio_schema.Timeline,
    json_items_by_id: Dict[str, TimelineItem],  # Map of json_item.id -> json_item
    catalog: OriginalTimelineCatalog, # Contains pre-cataloged OTIO items
) -> GroupSourceDataMap:
    group_source_data_map: GroupSourceDataMap = defaultdict(list)
    
    # Keep track of JSON items already mapped to a group to avoid double-counting
    # if a JSON item could somehow match multiple OTIO contexts (shouldn't happen with good IDs).
    # This set will store json_item_id that have been successfully mapped.
    used_json_item_ids_in_mapping: Set[str] = set()

    logger.debug("Starting _map_otio_to_json_edits to build GroupSourceDataMap...")

    # Iterate through the cataloged unique OTIO items/groups
    # catalog["ordered_items"] gives: (item_key, item_type_hint, representative_otio_item, group_abs_start_rt)
    for item_key, item_type_hint, _, group_abs_start_rt in catalog["ordered_items"]:
        if item_type_hint == "gap": # We only care about clips or clip groups
            continue

        # Get all OTIO clips belonging to this item_key (link group) from the catalog
        # catalog["clips_by_group_and_track"] is Dict[item_key, DefaultDict[track_idx, otio.schema.Clip]]
        otio_clips_in_this_group = catalog["clips_by_group_and_track"].get(item_key)
        if not otio_clips_in_this_group:
            logger.warning(f"No OTIO clips found in catalog for item_key '{item_key}'. Skipping.")
            continue

        source_data_for_this_group: List[Tuple[TimelineItem, EditInstructionsList]] = []

        # For each OTIO clip within this group...
        for otio_track_idx_0_based, otio_clip_in_group in otio_clips_in_this_group.items():
            if not otio_clip_in_group or not isinstance(otio_clip_in_group, otio_schema.Clip):
                continue

            # Determine track kind and Resolve track index for this specific otio_clip_in_group
            otio_parent_track = original_otio_timeline.tracks[otio_track_idx_0_based]
            current_otio_track_kind_str = "audio" # Default or derive more robustly
            if otio_parent_track.kind == otio_schema.TrackKind.Video:
                current_otio_track_kind_str = "video"
            elif otio_parent_track.kind == otio_schema.TrackKind.Audio:
                current_otio_track_kind_str = "audio"
            else:
                logger.debug(f"Skipping OTIO clip '{otio_clip_in_group.name}' in group '{item_key}' due to unknown track kind: {otio_parent_track.kind}")
                continue
            
            resolve_track_index_from_name = 0
            parts = otio_parent_track.name.split(" ")
            if len(parts) > 1 and parts[-1].isdigit():
                try: resolve_track_index_from_name = int(parts[-1])
                except ValueError: pass
            
            if resolve_track_index_from_name == 0:
                logger.warning(f"Could not determine Resolve track index for OTIO track '{otio_parent_track.name}' (clip '{otio_clip_in_group.name}'). Skipping this clip.")
                continue
            
            # Use the group's absolute start time for deriving the JSON ID.
            # This assumes all linked items start at the same logical point on the timeline.
            original_start_frame_int = int(round(group_abs_start_rt.value))

            otio_derived_json_id_candidate = _derive_json_id_from_otio_clip(
                otio_clip_in_group,
                current_otio_track_kind_str,
                resolve_track_index_from_name,
                original_start_frame_int,
            )
            
            # If this JSON item was already processed for another OTIO clip (should not happen if IDs are good)
            # For link groups, a json_id should only be added once to a group's list.
            # The check below ensures we only add a (JSONItem, EditInstructionsList) pair once per group.
            # This derived ID is for matching.
            
            matched_json_item = json_items_by_id.get(otio_derived_json_id_candidate)

            if matched_json_item:
                # Ensure we haven't already added this specific JSON item's data to this group
                # This check relies on json_item['id'] being unique across all timeline items
                json_item_actual_id = matched_json_item.get("id")
                already_added_to_this_group = any(
                    entry[0].get("id") == json_item_actual_id for entry in source_data_for_this_group
                )

                if not already_added_to_this_group and json_item_actual_id:
                    json_instructions = matched_json_item.get("edit_instructions")
                    if isinstance(json_instructions, list):
                        source_data_for_this_group.append( (matched_json_item, json_instructions) )
                        used_json_item_ids_in_mapping.add(json_item_actual_id) # Track that this json_id has been used
                        logger.debug(f"  Added JSON item '{json_item_actual_id}' (OTIO: '{otio_clip_in_group.name}') to group '{item_key}' with {len(json_instructions)} instructions.")
                    else: # Instructions are None or not a list - treat as full pass-through for this item
                        source_data_for_this_group.append( (matched_json_item, []) ) # Add with empty instructions
                        used_json_item_ids_in_mapping.add(json_item_actual_id)
                        logger.debug(f"  Added JSON item '{json_item_actual_id}' (OTIO: '{otio_clip_in_group.name}') to group '{item_key}' with NO instructions (empty list).")
                # else:
                    # logger.debug(f"  JSON item '{json_item_actual_id}' already processed for group '{item_key}'.")

            # else:
                # logger.debug(f"  No JSON item found for derived ID '{otio_derived_json_id_candidate}' (OTIO clip: {otio_clip_in_group.name}).")

        if source_data_for_this_group:
            group_source_data_map[item_key] = source_data_for_this_group
            logger.debug(f"Finalized group '{item_key}' with {len(source_data_for_this_group)} associated JSON items.")
        # else:
            # logger.warning(f"No JSON data could be associated with OTIO group '{item_key}'.")
            
    logger.info(f"Mapped {len(group_source_data_map)} OTIO groups to their source JSON data.")
    return group_source_data_map


def build_group_source_data_map( # Renamed function
    project_data: ProjectData,
    original_otio_timeline: otio_schema.Timeline,
    catalog: OriginalTimelineCatalog,
) -> GroupSourceDataMap:
    json_items_by_id = _index_json_timeline_items(project_data) # This is fine
    group_source_data = _map_otio_to_json_edits( # Call renamed function
        original_otio_timeline, json_items_by_id, catalog
    )
    return group_source_data




def _get_original_timeline_sound_ranges(
    json_item: TimelineItem,
    item_edits: EditInstructionsList,
    timeline_rate: float
) -> List[otio.opentime.TimeRange]:
    """
    Converts an item's EditInstructionList into a list of sound TimeRanges
    on the original timeline scale.
    """
    sound_ranges: List[otio.opentime.TimeRange] = []
    
    item_original_tl_start_frame = json_item["start_frame"]
    # item_original_duration_frames = json_item["duration"] # Or end_frame - start_frame + 1

    if not item_edits: # No edits means the entire original item is considered sound
        # Default to the item's original duration on the timeline if no edits are provided
        # This assumes an item with no edit_instructions is fully "enabled" for its original duration.
        original_duration_frames = json_item.get("duration")
        if original_duration_frames is None or original_duration_frames <= 1e-9:
            # Fallback if duration is not present or zero
            original_duration_frames = json_item["end_frame"] - json_item["start_frame"] + 1.0

        if original_duration_frames > 1e-9:
            start_time = otio.opentime.RationalTime(item_original_tl_start_frame, timeline_rate)
            duration = otio.opentime.RationalTime(original_duration_frames, timeline_rate)
            sound_ranges.append(otio.opentime.TimeRange(start_time, duration))
        return sound_ranges

    # If there are edits, these define the sound segments *relative to the item's own source start*.
    # The EditInstruction's StartFrame/EndFrame are for the *new compacted timeline* if keepSilenceSegments=False.
    # This is the part that's hard to reverse IF `keepSilenceSegments=False` was used by Go.
    #
    # Let's assume `EditInstruction`s from Go, when keepSilenceSegments=False,
    # essentially list the source chunks that AREN'T silence.
    # Each instruction `instr` has `instr["source_start_frame"]` and `instr["source_end_frame"]`.
    # This is a segment of sound from *that item's source media*.
    # We need to map this source media segment to its position on the *original timeline*.
    
    item_source_offset_on_timeline = item_original_tl_start_frame - json_item["source_start_frame"]

    for instr in item_edits:
        if not instr.get("enabled", True): # Skip if instruction is for a disabled segment (e.g. kept silence)
            continue
            
        # These are from the item's own source media
        source_seg_start_frame = instr["source_start_frame"]
        source_seg_end_frame_inclusive = instr["source_end_frame"]
        
        # Map to original timeline frames
        # This places the source segment onto the original timeline where this item was
        original_tl_seg_start_frame = source_seg_start_frame + item_source_offset_on_timeline
        original_tl_seg_end_frame_inclusive = source_seg_end_frame_inclusive + item_source_offset_on_timeline
        
        seg_duration_frames = original_tl_seg_end_frame_inclusive - original_tl_seg_start_frame + 1.0
        
        if seg_duration_frames > 1e-9:
            start_time = otio.opentime.RationalTime(original_tl_seg_start_frame, timeline_rate)
            duration = otio.opentime.RationalTime(seg_duration_frames, timeline_rate)
            sound_ranges.append(otio.opentime.TimeRange(start_time, duration))
            
    # It's possible these ranges might overlap if EditInstructions were not minimal; merge them.
    # OTIO TimeRanges can be tricky to merge directly. A common utility for merging TimeRange list might be needed.
    # For simplicity, let's assume Go's EditInstructions are non-overlapping for a single item.
    # If not, they should be merged here.

    return sound_ranges


def _intersect_sound_ranges(
    list_of_sound_range_lists: List[List[otio.opentime.TimeRange]],
    timeline_rate: float # Needed for creating new TimeRanges
) -> List[otio.opentime.TimeRange]:
    if not list_of_sound_range_lists:
        return []
    if len(list_of_sound_range_lists) == 1:
        return list_of_sound_range_lists[0]

    # Start with the sound ranges of the first item as the current intersection
    current_intersection = list_of_sound_range_lists[0]

    for i in range(1, len(list_of_sound_range_lists)):
        next_item_sound_ranges = list_of_sound_range_lists[i]
        new_intersection: List[otio.opentime.TimeRange] = []
        
        # Intersect current_intersection with next_item_sound_ranges
        # This is a simplified interval intersection. More robust libraries might exist.
        idx_current = 0
        idx_next = 0
        while idx_current < len(current_intersection) and idx_next < len(next_item_sound_ranges):
            range1 = current_intersection[idx_current]
            range2 = next_item_sound_ranges[idx_next]

            # Calculate overlap
            overlap_start_rt = max(range1.start_time, range2.start_time)
            overlap_end_rt = min(range1.end_time_exclusive(), range2.end_time_exclusive())
            
            if overlap_start_rt < overlap_end_rt: # If there is an overlap
                overlap_duration_rt = overlap_end_rt - overlap_start_rt
                if overlap_duration_rt.value > 1e-9: # Ensure positive duration
                    new_intersection.append(otio.opentime.TimeRange(overlap_start_rt, overlap_duration_rt))
            
            # Advance pointers
            if range1.end_time_exclusive() < range2.end_time_exclusive():
                idx_current += 1
            elif range2.end_time_exclusive() < range1.end_time_exclusive():
                idx_next += 1
            else: # Both end at the same time
                idx_current += 1
                idx_next += 1
        
        current_intersection = new_intersection
        if not current_intersection: # If any intersection results in empty, then final is empty
            break 
            
    # Merge potentially fragmented adjacent/overlapping ranges from the intersection process
    # This requires a robust TimeRange merge utility, similar to frame-based MergeIntervals
    # For now, assuming the intersection process above might produce fragmented but non-overlapping ranges
    # A proper merge would sort current_intersection by start_time and then merge.
    return current_intersection


def _generate_merged_edit_instructions_for_group(
    instruction_tuples: List[Tuple[TimelineItem, EditInstructionsList]],
    timeline_rate: float
) -> List[otio.opentime.TimeRange]: # Returns list of merged sound TimeRanges on original timeline
    """
    Merges edit instructions from multiple linked items to find common sound segments
    on the original timeline.
    """
    if not instruction_tuples:
        logger.warning("No instruction tuples provided for merging.")
        return []

    all_items_sound_ranges_on_orig_timeline: List[List[otio.opentime.TimeRange]] = []

    for json_item, item_edits in instruction_tuples:
        # Ensure 'start_frame', 'end_frame', 'source_start_frame', 'duration' exist and are numbers.
        # Add validation here if necessary.
        if not all (k in json_item and isinstance(json_item[k], (int,float)) for k in ['start_frame', 'end_frame', 'source_start_frame', 'duration']):
            logger.error(f"JSON item {json_item.get('id')} is missing required frame/duration fields for merging. Skipping.")
            # If one item is invalid, how to treat the whole group?
            # Option 1: Treat this item as fully silent (empty sound_ranges).
            # Option 2: Exclude it from the intersection (effectively ignoring its silence contribution).
            # Option 3: Fail the group merge.
            # Let's go with Option 1: if an item has bad data, it contributes no sound.
            all_items_sound_ranges_on_orig_timeline.append([])
            continue

        sound_ranges = _get_original_timeline_sound_ranges(json_item, item_edits, timeline_rate)
        all_items_sound_ranges_on_orig_timeline.append(sound_ranges)
        logger.debug(f"  Item {json_item.get('id')}: Original timeline sound ranges: {[ (r.start_time.value, r.duration.value) for r in sound_ranges]}")

    if not all_items_sound_ranges_on_orig_timeline: # e.g. all items had bad data
        return []

    merged_sound_ranges_on_orig_timeline = _intersect_sound_ranges(all_items_sound_ranges_on_orig_timeline, timeline_rate)
    
    logger.info(f"For group, merged into {len(merged_sound_ranges_on_orig_timeline)} common sound segments on original timeline.")
    for r in merged_sound_ranges_on_orig_timeline:
        logger.debug(f"    Merged common sound: Start={r.start_time.value}, Duration={r.duration.value}")
        
    return merged_sound_ranges_on_orig_timeline


def _catalog_original_timeline_items(
    original_timeline: otio_schema.Timeline,
    timeline_rate: float,
    global_start_offset_frames: float,
) -> OriginalTimelineCatalog:
    # (Implementation is correct)
    ordered_items: List[
        Tuple[str, str, Optional[TrackItemType], otio.opentime.RationalTime]
    ] = []
    clips_by_group_and_track: DefaultDict[str, DefaultDict[int, otio_schema.Clip]] = (
        defaultdict(lambda: defaultdict(otio_schema.Clip))
    )
    temp_processed_item_keys: Set[str] = set()
    for track_idx_0_based, track_instance in enumerate(original_timeline.tracks):
        current_pos_on_track_rt = otio.opentime.RationalTime(0, timeline_rate)
        for item_idx_on_track, item_on_orig_track in enumerate(track_instance):
            if not isinstance(
                item_on_orig_track,
                (otio_schema.Clip, otio_schema.Gap, otio_schema.Transition),
            ):
                continue
            item_key = _generate_otio_item_map_key(
                item_on_orig_track, track_idx_0_based, item_idx_on_track
            )
            item_type_hint = (
                "gap"
                if isinstance(item_on_orig_track, otio_schema.Gap)
                else (
                    "clip_group"
                    if isinstance(item_on_orig_track, otio_schema.Clip)
                    else "other"
                )
            )
            original_item_abs_start_rt = (
                otio.opentime.RationalTime(global_start_offset_frames, timeline_rate)
                + current_pos_on_track_rt
            )
            if item_type_hint == "clip_group" and isinstance(
                item_on_orig_track, otio_schema.Clip
            ):
                clips_by_group_and_track[item_key][
                    track_idx_0_based
                ] = item_on_orig_track
            if item_key not in temp_processed_item_keys:
                ordered_items.append(
                    (
                        item_key,
                        item_type_hint,
                        item_on_orig_track,
                        original_item_abs_start_rt,
                    )
                )
                temp_processed_item_keys.add(item_key)
            current_pos_on_track_rt += item_on_orig_track.duration()
    ordered_items.sort(key=lambda x: x[3])
    logger.debug(
        f"Cataloged {len(ordered_items)} unique items/groups from original timeline."
    )
    catalog_result: OriginalTimelineCatalog = {
        "ordered_items": ordered_items,
        "clips_by_group_and_track": clips_by_group_and_track,
    }
    return catalog_result


def apply_merged_segments_to_new_timeline(
    item_key: str,  # OTIO group key
    merged_sound_segments_on_original_timeline: List[otio.opentime.TimeRange],
    json_items_in_group: List[TimelineItem],  # The JSON TimelineItem dicts that formed this group
    original_otio_clips_for_group: DefaultDict[int, Optional[otio_schema.Clip]],  # track_idx -> otio.Clip
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    original_group_start_rt_on_new_timeline: otio.opentime.RationalTime, # Intended start for this group
    next_link_group_id: int,
    # Optional: Add remove_gaps: bool = False if you want to toggle behavior
) -> int:
    logger.debug(
        f"Applying MERGED segments for OTIO group '{item_key}'. "
        f"Received {len(merged_sound_segments_on_original_timeline)} merged sound segments. "
        f"Original intended start on new timeline: {original_group_start_rt_on_new_timeline.value}. "
        f"Initial next_link_group_id: {next_link_group_id}."
    )

    current_id_for_this_groups_segments = next_link_group_id

    if not merged_sound_segments_on_original_timeline:
        logger.debug(f"  No merged sound segments to apply for '{item_key}'. Group will be empty. Link Group ID remains {current_id_for_this_groups_segments}.")
        # If the group is entirely silent, no clips are added.
        # We need to ensure cursors on involved tracks are advanced to at least original_group_start_rt_on_new_timeline
        # IF other tracks might have content there.
        # The _pad_tracks_to_common_duration at the end will handle overall timeline length.
        # However, we should ensure that if this group was supposed to occupy space, that space is respected
        # by advancing cursors on its tracks to where its content *would have ended* if it had its original duration.
        # This is complex if it's fully silent.
        # For now, if no segments, this function does nothing, and cursors aren't advanced for this group's tracks
        # beyond where they were before this call (or where the initial sync put them).
        # A simpler approach for fully silent groups: ensure tracks are at least at original_group_start_rt_on_new_timeline
        involved_track_indices_for_empty_group = [
            idx for idx, clip_obj in original_otio_clips_for_group.items()
            if clip_obj and isinstance(clip_obj, otio_schema.Clip) and idx < len(new_track_cursors_relative_rt)
        ]
        for idx in involved_track_indices_for_empty_group:
            if new_track_cursors_relative_rt[idx] < original_group_start_rt_on_new_timeline:
                 gap_to_original_start = original_group_start_rt_on_new_timeline - new_track_cursors_relative_rt[idx]
                 if gap_to_original_start.value > 1e-9:
                     new_timeline.tracks[idx].append(otio_schema.Gap(duration=gap_to_original_start))
                     new_track_cursors_relative_rt[idx] = original_group_start_rt_on_new_timeline
        return current_id_for_this_groups_segments


    involved_track_indices = [
        idx for idx, clip_obj in original_otio_clips_for_group.items()
        if clip_obj and isinstance(clip_obj, otio_schema.Clip) and idx < len(new_track_cursors_relative_rt)
    ]
    if not involved_track_indices:
        logger.error(f"Cannot apply merged edits for {item_key}: No valid original OTIO clips/track indices found in group.")
        return current_id_for_this_groups_segments
        
    # --- Determine Effective Start Time for this Group on the New Timeline ---
    # The group should start at its original_group_start_rt_on_new_timeline,
    # OR later if previous content on any of its tracks extends beyond that point.
    max_cursor_before_this_group = otio.opentime.RationalTime(0, timeline_rate)
    for idx in involved_track_indices:
        max_cursor_before_this_group = max(max_cursor_before_this_group, new_track_cursors_relative_rt[idx])
    
    effective_group_placement_start_rt = max(
        max_cursor_before_this_group,
        original_group_start_rt_on_new_timeline # This ensures original gaps are respected
    )
    # (If 'remove_gaps' feature is True, effective_group_placement_start_rt would just be max_cursor_before_this_group)

    logger.debug(f"  Group '{item_key}': Effective placement start on new timeline: {effective_group_placement_start_rt.value}")

    # --- Sync Cursors of Involved Tracks to this Effective Start Time ---
    for idx in involved_track_indices:
        gap_to_effective_start = effective_group_placement_start_rt - new_track_cursors_relative_rt[idx]
        if gap_to_effective_start.value > 1e-9: 
            target_track_instance = new_timeline.tracks[idx]
            logger.debug(f"    Track {idx}: Inserting pre-group gap of {gap_to_effective_start.value} to reach effective start {effective_group_placement_start_rt.value}")
            target_track_instance.append(otio_schema.Gap(duration=gap_to_effective_start))
            new_track_cursors_relative_rt[idx] = effective_group_placement_start_rt
    # --- Cursors for involved tracks are now synced to effective_group_placement_start_rt ---

    # This will track the end of the last placed segment *within this group* to ensure contiguity.
    # It starts where the group itself starts.
    current_placement_cursor_for_group_segments = effective_group_placement_start_rt

    for merged_segment_idx, merged_segment_tr in enumerate(merged_sound_segments_on_original_timeline):
        # merged_segment_tr is a TimeRange on the ORIGINAL timeline scale.
        # Its start_time and duration define a common sound segment.
        
        rt_segment_duration = merged_segment_tr.duration
        if rt_segment_duration.value <= 1e-9: # Skip zero or negative duration segments
            logger.debug(f"  Skipping zero/negative duration merged segment {merged_segment_idx} for group '{item_key}'.")
            continue

        # Segments *within* an edited group are placed contiguously.
        # The current_placement_cursor_for_group_segments holds where the next segment should start.
        rt_placement_for_this_segment_on_new_timeline = current_placement_cursor_for_group_segments
        
        current_segment_link_id_to_assign = current_id_for_this_groups_segments
        processed_at_least_one_track_for_this_segment = False
        
        # This will store the actual end time of the segment placed on tracks.
        # Used to check if all linked clips within this segment end at the same time.
        actual_segment_end_rt_this_iteration = None 

        # For each OTIO clip that was part of the original link group...
        for original_track_idx, original_otio_clip in original_otio_clips_for_group.items():
            if not (original_otio_clip and isinstance(original_otio_clip, otio_schema.Clip) and original_track_idx in involved_track_indices):
                continue

            target_track_instance = new_timeline.tracks[original_track_idx]

            # Find the corresponding JSON TimelineItem for this original_otio_clip
            # to get its source_start_frame and original timeline start_frame.
            found_json_item_for_otio_clip: Optional[TimelineItem] = None
            # Matching logic (simplified):
            otio_parent_track_for_kind_name = new_timeline.tracks[original_track_idx] # Get from original to match cataloging
            parent_track_kind_str = "audio"
            if otio_parent_track_for_kind_name.kind == otio_schema.TrackKind.Video:
                parent_track_kind_str = "video"
            
            resolve_idx_from_name = 0
            parts = otio_parent_track_for_kind_name.name.split(" ")
            if len(parts) > 1 and parts[-1].isdigit():
                try: resolve_idx_from_name = int(parts[-1])
                except ValueError: pass
            
            for ji in json_items_in_group:
                # Ensure keys exist before accessing, with defaults if necessary
                ji_track_idx = ji.get("track_index")
                ji_track_type = ji.get("track_type")
                if ji_track_idx == resolve_idx_from_name and ji_track_type == parent_track_kind_str:
                    found_json_item_for_otio_clip = ji
                    break
            
            if not found_json_item_for_otio_clip:
                logger.error(f"    Group '{item_key}', Segment {merged_segment_idx}: Could not find matching JSON item for OTIO clip '{original_otio_clip.name}' on original track index {original_track_idx}. Skipping this track for current segment.")
                continue

            json_item = found_json_item_for_otio_clip
            
            # Map the merged_segment_tr (which is on original timeline scale) back to this json_item's source frames
            item_source_start_frames = json_item["source_start_frame"]
            item_original_timeline_start_frames = json_item["start_frame"]

            # merged_segment_tr.start_time.value is frame number on original timeline
            # Calculate this segment's start relative to the item's original timeline start
            segment_start_relative_to_item_tl_start = merged_segment_tr.start_time.value - item_original_timeline_start_frames
            
            # This is the start of the sound segment within the item's source media
            instr_source_start_frame = item_source_start_frames + segment_start_relative_to_item_tl_start
            # Duration is rt_segment_duration (which is merged_segment_tr.duration).
            # instr_source_end_frame_inclusive = instr_source_start_frame + rt_segment_duration.value - 1.0 # Not directly needed for OTIO source_range

            # Create new OTIO clip source range (absolute within the media file)
            media_ref = original_otio_clip.media_reference
            media_available_range_start_offset = 0.0 # Default if no available_range
            if media_ref and isinstance(media_ref, otio_schema.ExternalReference) and \
               media_ref.available_range and media_ref.available_range.start_time:
                media_available_range_start_offset = float(media_ref.available_range.start_time.value)

            true_abs_source_start_rt = otio.opentime.RationalTime(
                media_available_range_start_offset + instr_source_start_frame, timeline_rate
            )
            
            new_segment_item = original_otio_clip.clone()
            new_segment_item.source_range = otio.opentime.TimeRange(
                start_time=true_abs_source_start_rt,
                duration=rt_segment_duration # Use the common duration of the merged sound segment
            )
            new_segment_item.enabled = True # Merged segments are always enabled sound
            if "Resolve_OTIO" not in new_segment_item.metadata: new_segment_item.metadata["Resolve_OTIO"] = {}
            new_segment_item.metadata["Resolve_OTIO"]["Link Group ID"] = current_segment_link_id_to_assign
            
            # --- Placement on new timeline track ---
            # All involved tracks were synced to effective_group_placement_start_rt.
            # Segments within the group are placed contiguously based on current_placement_cursor_for_group_segments.
            current_track_cursor = new_track_cursors_relative_rt[original_track_idx]
            
            # Gap needed to reach the start of this specific segment on this track
            gap_for_this_segment_placement = rt_placement_for_this_segment_on_new_timeline - current_track_cursor
            
            if gap_for_this_segment_placement.value > 1e-9:
                logger.debug(f"      Track {original_track_idx}: Inserting intra-group gap of {gap_for_this_segment_placement.value} to place segment {merged_segment_idx} at {rt_placement_for_this_segment_on_new_timeline.value}")
                target_track_instance.append(otio_schema.Gap(duration=gap_for_this_segment_placement))
            elif gap_for_this_segment_placement.value < -1e-9: # Should not happen if logic is correct
                logger.error(f"    Track {original_track_idx}: Cursor {current_track_cursor.value} is AHEAD of target placement {rt_placement_for_this_segment_on_new_timeline.value} for segment {merged_segment_idx} of group {item_key}. This indicates an overlap.")
            
            target_track_instance.append(new_segment_item)
            
            # The segment ends at its placement start + its duration
            this_segment_actual_end_on_track = rt_placement_for_this_segment_on_new_timeline + rt_segment_duration
            new_track_cursors_relative_rt[original_track_idx] = this_segment_actual_end_on_track

            # --- Sync Check for this segment across tracks ---
            if actual_segment_end_rt_this_iteration is None:
                actual_segment_end_rt_this_iteration = this_segment_actual_end_on_track
            elif abs((actual_segment_end_rt_this_iteration - this_segment_actual_end_on_track).value) > 1e-7:
                 logger.error(
                     f"    MERGED SEGMENT CURSOR DESYNC on track {original_track_idx} for segment {merged_segment_idx} of group {item_key}! "
                     f"Expected end {actual_segment_end_rt_this_iteration.value}, got {this_segment_actual_end_on_track.value}"
                 )

            processed_at_least_one_track_for_this_segment = True
            logger.debug(f"      Appended segment {merged_segment_idx} (dur: {rt_segment_duration.value}) to track {original_track_idx} for group '{item_key}'. New cursor: {this_segment_actual_end_on_track.value}")


        # After processing all tracks for this merged_segment_tr:
        if actual_segment_end_rt_this_iteration is not None:
            # All tracks should have ended at the same point for this segment.
            # Update the cursor for the *next* segment within the group.
            current_placement_cursor_for_group_segments = actual_segment_end_rt_this_iteration
        
        if processed_at_least_one_track_for_this_segment:
            current_id_for_this_groups_segments += 1 # Increment Link ID for the next distinct segment group
        else:
            logger.warning(f"  Merged segment {merged_segment_idx} for OTIO group '{item_key}' resulted in no clips being added to any track.")
            # If no clips were added, current_placement_cursor_for_group_segments doesn't advance based on this segment.
            # It will remain where it was, which means the next segment will try to place itself there.
            
    return current_id_for_this_groups_segments

def _apply_unedited_clips_to_new_timeline(
    # (Implementation is correct)
    item_key: str,
    original_item_abs_start_rt: otio.opentime.RationalTime,
    original_clips_for_group: DefaultDict[int, otio_schema.Clip],
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    global_start_offset_frames: float,
) -> None:
    target_placement_start_relative_rt = (
        original_item_abs_start_rt
        - otio.opentime.RationalTime(global_start_offset_frames, timeline_rate)
    )
    logger.debug(
        f"Applying unedited item/group '{item_key}' at relative time {target_placement_start_relative_rt.value}"
    )
    for track_idx_orig, original_clip_to_copy in original_clips_for_group.items():
        if track_idx_orig >= len(new_timeline.tracks):
            continue
        target_track = new_timeline.tracks[track_idx_orig]
        gap_needed = (
            target_placement_start_relative_rt
            - new_track_cursors_relative_rt[track_idx_orig]
        )
        if gap_needed.value > 1e-9:
            target_track.append(otio_schema.Gap(duration=gap_needed))
        cloned_clip = original_clip_to_copy.clone()
        target_track.append(cloned_clip)
        new_track_cursors_relative_rt[track_idx_orig] = (
            target_placement_start_relative_rt + cloned_clip.duration()
        )


def _pad_tracks_to_common_duration(
    # (Implementation is correct)
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
) -> None:
    max_duration_rt = otio.opentime.RationalTime(0, new_timeline.global_start_time.rate)
    for cursor_rt in new_track_cursors_relative_rt:
        if cursor_rt > max_duration_rt:
            max_duration_rt = cursor_rt
    logger.debug(f"Padding tracks to common relative duration: {max_duration_rt.value}")
    for i, track_to_pad in enumerate(new_timeline.tracks):
        gap_needed_rt = max_duration_rt - new_track_cursors_relative_rt[i]
        if gap_needed_rt.value > 1e-9:
            track_to_pad.append(otio_schema.Gap(duration=gap_needed_rt))


def edit_timeline_with_precalculated_instructions(
    otio_timeline_path: str,
    project_data: ProjectData,
    output_otio_path: str,
) -> None:
    otio_data = load_otio_timeline_data(otio_timeline_path)
    original_timeline = otio_data["timeline"]
    timeline_rate = otio_data["rate"]
    global_start_offset_frames = otio_data["global_start_offset_frames"]

    logger.info("Starting timeline editing process (Main Orchestrator with Merging Logic).")

    catalog: OriginalTimelineCatalog = _catalog_original_timeline_items(
        original_timeline, timeline_rate, global_start_offset_frames
    )
    group_source_data_map: GroupSourceDataMap = build_group_source_data_map(
        project_data, original_timeline, catalog
    )

    new_timeline = otio_schema.Timeline(
        name=f"{original_timeline.name or 'Timeline'} - Merged Edits Applied",
        global_start_time=copy.deepcopy(original_timeline.global_start_time),
    )
    for orig_track in original_timeline.tracks:
        new_track = otio_schema.Track(name=orig_track.name, kind=orig_track.kind)
        new_timeline.tracks.append(new_track)
    
    current_timeline_rate_for_cursors = timeline_rate
    if new_timeline.global_start_time and new_timeline.global_start_time.rate > 0:
        current_timeline_rate_for_cursors = new_timeline.global_start_time.rate

    new_track_cursors_relative_rt: List[otio.opentime.RationalTime] = [
        otio.opentime.RationalTime(0, current_timeline_rate_for_cursors) for _ in new_timeline.tracks
    ]
    
    max_orig_id = _get_max_original_link_group_id(original_timeline)
    next_link_group_id_for_main_loop = max_orig_id + 1
    logger.debug(f"Max original Link Group ID: {max_orig_id}. Initializing next_link_group_id: {next_link_group_id_for_main_loop}")


    for item_key, item_type_hint, _, original_item_abs_start_rt in catalog["ordered_items"]:
        logger.debug(f"Processing OTIO item_key: '{item_key}', Type: '{item_type_hint}'")
        if item_type_hint == "gap":
            # Handle gaps if necessary, or ensure cursor logic correctly skips over them based on original timeline.
            # For now, if a gap is encountered in ordered_items, and it's not part of a group that gets edits,
            # it might be skipped. The _apply_unedited_clips... handles non-edited groups.
            # This section might need more robust gap handling based on `original_item_object`.
            logger.debug(f"  Skipping cataloged gap object '{item_key}'. Gaps on new timeline are byproducts of edits.")
            continue

        instruction_tuples_for_group = group_source_data_map.get(item_key)
        original_otio_clips_for_this_group = catalog["clips_by_group_and_track"].get(item_key, defaultdict(lambda: None))

        group_target_start_on_new_timeline_rt = (
            original_item_abs_start_rt - 
            otio.opentime.RationalTime(global_start_offset_frames, timeline_rate)
        )

        if not original_otio_clips_for_this_group or all(c is None for c in original_otio_clips_for_this_group.values()):
            logger.warning(f"  No valid OTIO clips found for group '{item_key}'. Skipping processing for this group.")
            continue


        if instruction_tuples_for_group: # JSON data found for this OTIO group
            logger.debug(f"  Found {len(instruction_tuples_for_group)} JSON items with instruction data for group '{item_key}'.")
            
            merged_sound_segments_on_orig_tl = _generate_merged_edit_instructions_for_group(
                instruction_tuples_for_group, timeline_rate
            )

            if not merged_sound_segments_on_orig_tl:
                 logger.info(f"  Group '{item_key}' resulted in zero common sound segments after merging. It will be entirely silent (gap).")

            # Pass the list of original JSON items that were part of this group
            json_items_in_this_group = [t[0] for t in instruction_tuples_for_group]

            next_link_group_id_for_main_loop = apply_merged_segments_to_new_timeline(
                item_key=item_key,
                merged_sound_segments_on_original_timeline=merged_sound_segments_on_orig_tl,
                json_items_in_group=json_items_in_this_group,
                original_otio_clips_for_group=original_otio_clips_for_this_group,
                new_timeline=new_timeline,
                new_track_cursors_relative_rt=new_track_cursors_relative_rt,
                timeline_rate=timeline_rate,
                original_group_start_rt_on_new_timeline=group_target_start_on_new_timeline_rt,
                next_link_group_id=next_link_group_id_for_main_loop,
            )
            logger.debug(f"  Finished applying merged segments for '{item_key}'. Next Link ID: {next_link_group_id_for_main_loop}")
        else: # No JSON data (and thus no instructions) for this OTIO group key
            logger.debug(f"  No JSON instruction data for OTIO group '{item_key}'. Applying as unedited.")
            _apply_unedited_clips_to_new_timeline(
                item_key,
                original_item_abs_start_rt,
                original_otio_clips_for_this_group,
                new_timeline,
                new_track_cursors_relative_rt,
                timeline_rate,
                global_start_offset_frames,
            )
            logger.debug(f"  Finished applying unedited for '{item_key}'.")
        
        logger.debug(f"  Track cursors after item_key '{item_key}': {[c.value for c in new_track_cursors_relative_rt]}")

    _pad_tracks_to_common_duration(new_timeline, new_track_cursors_relative_rt)
    otio.adapters.write_to_file(new_timeline, output_otio_path)
    #pprint(new_timeline)
    logger.info(f"Merged edits OTIO timeline saved to: {output_otio_path}")

if __name__ == "__main__":
    start_time = time.time()
    current_dir = os.path.dirname(os.path.abspath(__file__))
    otio_input_path = os.path.join(current_dir, "pre-edit_timeline_export.otio")
    project_json_path = os.path.join(current_dir, "silence_detections.json")
    otio_output_path = os.path.join(current_dir, "edited_timeline_refactored.otio")
    logging.getLogger().setLevel(logging.ERROR)

    if not os.path.exists(otio_input_path):
        logger.error(f"Input OTIO file not found: {otio_input_path}")
        exit(1)
    if not os.path.exists(project_json_path):
        logger.error(f"Project JSON file not found: {project_json_path}")
        exit(1)

    project_data_content: ProjectData = load_project_data(project_json_path)
    edit_timeline_with_precalculated_instructions(
        otio_input_path, project_data_content, otio_output_path
    )
    logger.info("Timeline editing process finished successfully.")

    end_time = time.time()
    elapsed_time = end_time - start_time
    print(f"Elapsed time: {elapsed_time:.2f} seconds")
