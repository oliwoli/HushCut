import os
from tracemalloc import start
import opentimelineio as otio
from collections.abc import Mapping
import time
import json
import copy
import logging
import math
from collections import defaultdict
from typing import (
    List,
    Dict,
    NotRequired,
    Optional,
    DefaultDict,
    Set,
    Tuple,
    TypedDict,
    Union,
    Any,
)
from opentimelineio import opentime, schema as otio_schema
import opentimelineio

from local_types import ProjectData, EditInstruction, TimelineItem
import globalz

from pprint import pprint

# from pprint import pprint
# --- Logging Setup ---
logging.basicConfig(level=logging.ERROR, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

TrackItemType = Union[otio_schema.Clip, otio_schema.Gap, otio_schema.Transition]


class LinkedItemProp(TypedDict):
    track_index: int
    track_type: str  # "video", "audio", "subtitle"
    start_frame: float


class ApiEditInstruction(EditInstruction):
    linked_items: List[LinkedItemProp]


class SubframeEditsData(TypedDict):
    bmd_media_pool_item: Any  # we can take this from project data!
    edit_instructions: List[ApiEditInstruction]
    track_type: str  # "video", "audio", "subtitle"
    track_index: int
    bmd_tl_item: NotRequired[Any]  # to be added later


class OriginalTimelineCatalog(TypedDict):
    ordered_items: List[
        Tuple[str, str, Optional[TrackItemType], otio.opentime.RationalTime]
    ]
    clips_by_group_and_track: DefaultDict[str, DefaultDict[int, otio_schema.Clip]]


class OtioTimelineData(TypedDict):
    timeline: otio.schema.Timeline
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
    original_start_frame_float: float,
) -> str:
    """Constructs the candidate JSON ID to match main.py's format."""
    # Format: ClipName-TrackType-ResolveTrackIndex--TimelineStartFrame
    return f"{otio_clip.name}-{otio_track_kind_str}-{resolve_style_track_index}--{original_start_frame_float}"


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
    json_items_by_id: Dict[str, TimelineItem],
    catalog: OriginalTimelineCatalog,
    global_start_offset_frames: float,
) -> GroupSourceDataMap:
    group_source_data_map: GroupSourceDataMap = defaultdict(list)
    used_json_item_ids_in_mapping: Set[str] = set()

    for item_key, item_type_hint, _, group_abs_start_rt in catalog["ordered_items"]:
        if item_type_hint == "gap":
            continue

        otio_clips_in_this_group = catalog["clips_by_group_and_track"].get(item_key)
        if not otio_clips_in_this_group:
            continue

        source_data_for_this_group: List[Tuple[TimelineItem, EditInstructionsList]] = []

        for (
            otio_track_idx_0_based,
            otio_clip_in_group,
        ) in otio_clips_in_this_group.items():
            if not (
                otio_clip_in_group and isinstance(otio_clip_in_group, otio_schema.Clip)
            ):
                continue

            otio_parent_track = original_otio_timeline.tracks[otio_track_idx_0_based]
            current_otio_track_kind_str = "audio"
            if otio_parent_track.kind == otio_schema.TrackKind.Video:
                current_otio_track_kind_str = "video"
            elif otio_parent_track.kind == otio_schema.TrackKind.Audio:
                current_otio_track_kind_str = "audio"
            else:
                continue

            resolve_track_index_from_name = 0
            parts = otio_parent_track.name.split(" ")
            if len(parts) > 1 and parts[-1].isdigit():
                try:
                    resolve_track_index_from_name = int(parts[-1])
                except ValueError:
                    pass

            if resolve_track_index_from_name == 0:
                continue

            # --- THIS IS THE CORRECTED ID LOGIC ---
            # Calculate the start frame RELATIVE to the timeline's start (0-point)
            relative_start_frame_float = (
                group_abs_start_rt.value - global_start_offset_frames
            )

            otio_derived_json_id_candidate = _derive_json_id_from_otio_clip(
                otio_clip_in_group,
                current_otio_track_kind_str,
                resolve_track_index_from_name,
                relative_start_frame_float,  # Use the RELATIVE frame number
            )
            # --- END CORRECTION ---

            matched_json_item = json_items_by_id.get(otio_derived_json_id_candidate)

            if matched_json_item:
                json_item_actual_id = matched_json_item.get("id")
                already_added_to_this_group = any(
                    entry[0].get("id") == json_item_actual_id
                    for entry in source_data_for_this_group
                )

                if not already_added_to_this_group and json_item_actual_id:
                    json_instructions = matched_json_item.get("edit_instructions")
                    if isinstance(json_instructions, list):
                        source_data_for_this_group.append(
                            (matched_json_item, json_instructions)
                        )
                        used_json_item_ids_in_mapping.add(json_item_actual_id)
                    else:
                        source_data_for_this_group.append((matched_json_item, []))
                        used_json_item_ids_in_mapping.add(json_item_actual_id)

        if source_data_for_this_group:
            group_source_data_map[item_key] = source_data_for_this_group

    return group_source_data_map


def build_group_source_data_map(
    project_data: ProjectData,
    original_otio_timeline: otio_schema.Timeline,
    catalog: OriginalTimelineCatalog,
    global_start_offset_frames: float,
) -> GroupSourceDataMap:
    json_items_by_id = _index_json_timeline_items(project_data)
    group_source_data = _map_otio_to_json_edits(
        original_otio_timeline, json_items_by_id, catalog, global_start_offset_frames
    )
    return group_source_data


def _get_original_timeline_sound_ranges(
    json_item: TimelineItem, item_edits: EditInstructionsList, timeline_rate: float
) -> List[otio.opentime.TimeRange]:
    """
    Converts an item's EditInstructionList into a list of sound TimeRanges
    on the original timeline scale.
    """
    sound_ranges: List[otio.opentime.TimeRange] = []

    item_original_tl_start_frame = json_item["start_frame"]
    # item_original_duration_frames = json_item["duration"] # Or end_frame - start_frame + 1

    if not item_edits:  # No edits means the entire original item is considered sound
        # Default to the item's original duration on the timeline if no edits are provided
        # This assumes an item with no edit_instructions is fully "enabled" for its original duration.
        original_duration_frames = json_item.get("duration")
        if original_duration_frames is None or original_duration_frames <= 1e-9:
            # Fallback if duration is not present or zero
            original_duration_frames = (
                json_item["end_frame"] - json_item["start_frame"] + 1.0
            )

        if original_duration_frames > 1e-9:
            start_time = otio.opentime.RationalTime(
                item_original_tl_start_frame, timeline_rate
            )
            duration = otio.opentime.RationalTime(
                original_duration_frames, timeline_rate
            )
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

    item_source_offset_on_timeline = (
        item_original_tl_start_frame - json_item["source_start_frame"]
    )

    for instr in item_edits:
        if not instr.get(
            "enabled", True
        ):  # Skip if instruction is for a disabled segment (e.g. kept silence)
            continue

        # These are from the item's own source media
        source_seg_start_frame = instr["source_start_frame"]
        source_seg_end_frame_inclusive = instr["source_end_frame"]

        # Map to original timeline frames
        # This places the source segment onto the original timeline where this item was
        original_tl_seg_start_frame = (
            source_seg_start_frame + item_source_offset_on_timeline
        )
        original_tl_seg_end_frame_inclusive = (
            source_seg_end_frame_inclusive + item_source_offset_on_timeline
        )

        seg_duration_frames = (
            original_tl_seg_end_frame_inclusive - original_tl_seg_start_frame + 1.0
        )

        if seg_duration_frames > 1e-9:
            start_time = otio.opentime.RationalTime(
                original_tl_seg_start_frame, timeline_rate
            )
            duration = otio.opentime.RationalTime(seg_duration_frames, timeline_rate)
            sound_ranges.append(otio.opentime.TimeRange(start_time, duration))

    # It's possible these ranges might overlap if EditInstructions were not minimal; merge them.
    # OTIO TimeRanges can be tricky to merge directly. A common utility for merging TimeRange list might be needed.
    # For simplicity, let's assume Go's EditInstructions are non-overlapping for a single item.
    # If not, they should be merged here.

    return sound_ranges


def _intersect_sound_ranges(
    list_of_sound_range_lists: List[List[otio.opentime.TimeRange]],
    timeline_rate: float,  # Needed for creating new TimeRanges
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
        while idx_current < len(current_intersection) and idx_next < len(
            next_item_sound_ranges
        ):
            range1 = current_intersection[idx_current]
            range2 = next_item_sound_ranges[idx_next]

            # Calculate overlap
            overlap_start_rt = max(range1.start_time, range2.start_time)
            overlap_end_rt = min(
                range1.end_time_exclusive(), range2.end_time_exclusive()
            )

            if overlap_start_rt < overlap_end_rt:  # If there is an overlap
                overlap_duration_rt = overlap_end_rt - overlap_start_rt
                if overlap_duration_rt.value > 1e-9:  # Ensure positive duration
                    new_intersection.append(
                        otio.opentime.TimeRange(overlap_start_rt, overlap_duration_rt)
                    )

            # Advance pointers
            if range1.end_time_exclusive() < range2.end_time_exclusive():
                idx_current += 1
            elif range2.end_time_exclusive() < range1.end_time_exclusive():
                idx_next += 1
            else:  # Both end at the same time
                idx_current += 1
                idx_next += 1

        current_intersection = new_intersection
        if (
            not current_intersection
        ):  # If any intersection results in empty, then final is empty
            break

    # Merge potentially fragmented adjacent/overlapping ranges from the intersection process
    # This requires a robust TimeRange merge utility, similar to frame-based MergeIntervals
    # For now, assuming the intersection process above might produce fragmented but non-overlapping ranges
    # A proper merge would sort current_intersection by start_time and then merge.
    return current_intersection


def _generate_merged_edit_instructions_for_group(
    item_key: str,  # OTIO group identifier
    instruction_tuples: List[Tuple[TimelineItem, EditInstructionsList]],
    catalog: OriginalTimelineCatalog,  # Contains original OTIO data
    timeline_rate: float,
) -> List[otio.opentime.TimeRange]:
    """
    Merges edit instructions from multiple linked items to find common sound segments
    on the original timeline. If an item has no edits, its original placement is used.
    """
    if not instruction_tuples:
        return []

    all_items_sound_ranges_on_orig_timeline: List[List[otio.opentime.TimeRange]] = []

    # Get the original OTIO clips for this group from the catalog
    original_otio_clips_for_this_group = catalog["clips_by_group_and_track"].get(
        item_key
    )
    if not original_otio_clips_for_this_group:
        logger.error(
            f"Cannot generate merged edits for '{item_key}': No original OTIO clips found in catalog."
        )
        return []

    for json_item, item_edits in instruction_tuples:
        item_sound_ranges: List[otio.opentime.TimeRange] = []

        if not item_edits:
            # === THIS IS THE FIX BASED ON YOUR SUGGESTION ===
            # No edits exist. The "sound range" is the clip's entire original placement.
            # We get this directly from the original OTIO clip object via the catalog.

            found_otio_clip: Optional[otio.schema.Clip] = None
            json_track_idx = json_item.get("track_index")

            # The keys of original_otio_clips_for_this_group are the original track indices
            if (
                json_track_idx is not None
                and json_track_idx in original_otio_clips_for_this_group
            ):
                found_otio_clip = original_otio_clips_for_this_group[json_track_idx]

            if found_otio_clip:
                # The "range_in_parent" is the TimeRange of the clip on its track.
                # The cataloging process ensures all times are relative to a common timeline start.
                original_clip_range = found_otio_clip.range_in_parent()
                logger.debug(
                    f"  Item '{json_item.get('id')}' has no edits. Using its ground-truth OTIO range: start={original_clip_range.start_time.value}, dur={original_clip_range.duration.value}"
                )
                item_sound_ranges.append(original_clip_range)
            else:
                logger.warning(
                    f"  Could not find matching OTIO clip for JSON item '{json_item.get('id')}' which had no edits. It will be treated as fully silent for the purpose of merging."
                )
                # By not adding any ranges to item_sound_ranges, this item will contribute no "sound" to the intersection.

        else:  # Item has edits, we must still use the mapping logic.
            item_original_tl_start_frame = json_item["start_frame"]
            item_original_source_start_frame = json_item["source_start_frame"]
            item_source_offset_on_timeline = (
                item_original_tl_start_frame - item_original_source_start_frame
            )

            for instr in item_edits:
                if not instr.get("enabled", True):
                    continue

                source_seg_start_frame = instr["source_start_frame"]
                source_seg_end_frame_inclusive = instr["source_end_frame"]

                original_tl_seg_start_frame_float = (
                    source_seg_start_frame + item_source_offset_on_timeline
                )

                # We keep the rounding as it's good practice for the mapping calculation's stability
                rounded_tl_seg_start_frame = round(original_tl_seg_start_frame_float, 9)

                # Using the corrected duration calculation from before
                seg_duration_frames = (
                    source_seg_end_frame_inclusive - source_seg_start_frame
                )

                if seg_duration_frames > 1e-9:
                    start_time = otio.opentime.RationalTime(
                        rounded_tl_seg_start_frame, timeline_rate
                    )
                    duration = otio.opentime.RationalTime(
                        seg_duration_frames, timeline_rate
                    )
                    item_sound_ranges.append(
                        otio.opentime.TimeRange(start_time, duration)
                    )

        all_items_sound_ranges_on_orig_timeline.append(item_sound_ranges)

    # The intersection logic remains the same
    merged_sound_ranges = _intersect_sound_ranges(
        all_items_sound_ranges_on_orig_timeline, timeline_rate
    )

    logger.debug(
        f"For group '{item_key}', merged into {len(merged_sound_ranges)} common sound segments."
    )
    return merged_sound_ranges


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
                clips_by_group_and_track[item_key][track_idx_0_based] = (
                    item_on_orig_track
                )
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


def _apply_merged_segments_to_new_timeline(
    item_key: str,
    merged_sound_segments_on_original_timeline: List[otio.opentime.TimeRange],
    json_items_in_group: List[TimelineItem],
    original_otio_clips_for_group: DefaultDict[int, Optional[otio.schema.Clip]],
    original_timeline: otio.schema.Timeline,
    new_timeline: otio.schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    group_placement_anchor_rt: otio.opentime.RationalTime,  # ANCHOR POINT for the whole group
    next_link_group_id: int,
    use_api_for_subframe: bool,
) -> Tuple[int, List[SubframeEditsData]]:
    """
    Applies edited segments using a correct inclusive frame model, ensuring
    perfectly contiguous edits for the DaVinci Resolve API without gaps.
    """
    if not globalz.PROJECT_DATA:
        raise ValueError("Failed to initialize project data.")

    api_jobs_for_this_group: Dict[str, SubframeEditsData] = {}
    involved_track_indices = {
        idx
        for idx, clip_obj in original_otio_clips_for_group.items()
        if clip_obj
        and isinstance(clip_obj, otio.schema.Clip)
        and idx < len(new_track_cursors_relative_rt)
    }

    if not merged_sound_segments_on_original_timeline:
        return next_link_group_id, []

    # print("json items in group:")
    # pprint(json_items_in_group)

    # Align all track cursors to the start of this group's block
    for idx in involved_track_indices:
        pre_gap_needed = group_placement_anchor_rt - new_track_cursors_relative_rt[idx]
        if pre_gap_needed.value > 1e-9:
            new_timeline.tracks[idx].append(otio.schema.Gap(duration=pre_gap_needed))

    # This integer cursor tracks the precise STARTING frame for the next segment.
    compacted_timeline_cursor_frame = round(group_placement_anchor_rt.value)

    for merged_segment_idx, merged_segment_tr in enumerate(
        merged_sound_segments_on_original_timeline
    ):
        rt_segment_duration = merged_segment_tr.duration
        if rt_segment_duration.value <= 1:
            continue

        # The duration in frames (e.g., 7.49 -> 8 frames)
        compacted_clip_duration_frames = math.ceil(rt_segment_duration.value)
        if compacted_clip_duration_frames == 0:
            continue

        new_tl_start_frame = compacted_timeline_cursor_frame
        # 2. The end frame is INCLUSIVE. For a duration of 8, it's start + 8 - 1.
        new_tl_end_frame = new_tl_start_frame + compacted_clip_duration_frames - 1

        current_segment_link_id = next_link_group_id + merged_segment_idx
        compacted_duration_rt = otio.opentime.RationalTime(
            compacted_clip_duration_frames, timeline_rate
        )

        for original_track_idx in involved_track_indices:
            original_otio_clip = original_otio_clips_for_group[original_track_idx]
            if not original_otio_clip:
                print(
                    f"Warning: No original OTIO clip found for track index {original_track_idx} in group '{item_key}'. Skipping."
                )
                continue
            json_item = next(
                (
                    ji
                    for ji in json_items_in_group
                    if original_otio_clip.name in ji.get("id", "")
                ),
                None,
            )
            if not json_item:
                print(
                    f"Warning: No JSON item found for original OTIO clip '{original_otio_clip.name}' in group '{item_key}'. Skipping."
                )
                continue

            target_track_instance = new_timeline.tracks[original_track_idx]
            clip_needs_api = use_api_for_subframe and (
                _clip_has_subframe_placement(original_otio_clip)
                or _clip_has_subframe_data(json_item)
            )

            segment_offset = (
                merged_segment_tr.start_time.value - json_item["start_frame"]
            )
            source_start_frame = json_item["source_start_frame"] + segment_offset

            if clip_needs_api:
                if json_item["id"] not in api_jobs_for_this_group:
                    linked_items_props = []
                    for item in json_items_in_group:
                        if item["id"] == json_item["id"]:
                            continue
                        # Collect properties of linked items for API jobs
                        linked_items_props.append(
                            {
                                "track_index": item["track_index"],
                                "track_type": item["track_type"],
                                "start_frame": item["start_frame"],
                            }
                        )

                    bmd_item = globalz.PROJECT_DATA["files"][
                        json_item["source_file_path"]
                    ]["fileSource"]["bmd_media_pool_item"]
                    api_jobs_for_this_group[json_item["id"]] = {
                        "bmd_media_pool_item": bmd_item,
                        "edit_instructions": [],
                        "track_type": json_item["track_type"],
                        "track_index": json_item["track_index"],
                        "bmd_tl_item": None,
                    }

                # Source frames are also inclusive, so the duration match is (duration - 1)
                source_end_frame = (
                    source_start_frame + compacted_clip_duration_frames - 1
                )

                print("linked items:")
                pprint(linked_items_props)

                api_instr: ApiEditInstruction = {
                    "source_start_frame": 1,
                    "source_end_frame": source_end_frame,
                    "start_frame": float(new_tl_start_frame),
                    "end_frame": float(new_tl_end_frame),
                    "enabled": True,
                    "linked_items": linked_items_props,
                }

                api_jobs_for_this_group[json_item["id"]]["edit_instructions"].append(
                    api_instr
                )
                target_track_instance.append(
                    otio.schema.Gap(duration=compacted_duration_rt)
                )

            else:  # OTIO Path
                media_offset = (
                    original_otio_clip.media_reference.available_range.start_time.value
                    if original_otio_clip.media_reference.available_range
                    else 0.0
                )
                source_range_start_rt = otio.opentime.RationalTime(
                    media_offset + source_start_frame, timeline_rate
                )

                new_clip = original_otio_clip.clone()
                # The source range uses the original sub-frame duration, but will be placed
                # into an integer-frame slot on the timeline.
                new_clip.source_range = otio.opentime.TimeRange(
                    start_time=source_range_start_rt, duration=rt_segment_duration
                )
                if "Resolve_OTIO" not in new_clip.metadata:
                    new_clip.metadata["Resolve_OTIO"] = {}
                new_clip.metadata["Resolve_OTIO"]["Link Group ID"] = (
                    current_segment_link_id
                )
                target_track_instance.append(new_clip)

        # 3. The cursor for the *next* segment is the start frame + the duration.
        compacted_timeline_cursor_frame += compacted_clip_duration_frames

    # After all segments in the group are processed, update the main OTIO track cursors
    # to the final position of the compacted block.
    final_cursor_rt = otio.opentime.RationalTime(
        compacted_timeline_cursor_frame, timeline_rate
    )
    for idx in involved_track_indices:
        new_track_cursors_relative_rt[idx] = final_cursor_rt

    final_api_jobs = list(api_jobs_for_this_group.values())
    return next_link_group_id + len(
        merged_sound_segments_on_original_timeline
    ), final_api_jobs


def _apply_unedited_clips_to_new_timeline(
    item_key: str,
    target_placement_start_relative_rt: otio.opentime.RationalTime,
    original_clips_for_group: DefaultDict[int, otio.schema.Clip],
    new_timeline: otio.schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
) -> None:
    logger.debug(
        f"Applying UNEDITED item/group '{item_key}' at target relative time {target_placement_start_relative_rt.value}"
    )
    for track_idx_orig, original_clip_to_copy in original_clips_for_group.items():
        if not (
            original_clip_to_copy
            and isinstance(original_clip_to_copy, otio_schema.Clip)
        ):
            continue
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


def _clip_has_subframe_data(json_item: TimelineItem) -> bool:
    """Checks if a single TimelineItem has subframe-precise geometry."""
    frames_to_check = [
        # json_item.get("start_frame"),
        # json_item.get("end_frame"),
        json_item.get("source_start_frame"),
        json_item.get("source_end_frame"),
    ]
    for frame_value in frames_to_check:
        if frame_value is not None and not float(frame_value).is_integer():
            return True
    return False


def _group_has_subframe_data(
    instruction_tuples: List[Tuple[TimelineItem, EditInstructionsList]],
) -> bool:
    """Checks if any item in a group has subframe-precise geometry."""
    print(f"Checking group for subframe data: {instruction_tuples}")
    for json_item, _ in instruction_tuples:
        # Check all relevant frame values for this item
        frames_to_check = [
            json_item.get("start_frame"),
            json_item.get("end_frame"),
            json_item.get("source_start_frame"),
            json_item.get("source_end_frame"),
        ]
        for frame_value in frames_to_check:
            # float.is_integer() correctly handles both ints and floats like 2.0
            if frame_value is not None and not float(frame_value).is_integer():
                return True
    return False


def _clip_has_subframe_placement(otio_clip: otio.schema.Clip) -> bool:
    """
    Checks if an original OTIO clip object is placed on a subframe
    or has a subframe duration.
    """
    if not otio_clip:
        return False

    # Get the clip's placement and duration on its original track
    clip_range = otio_clip.range_in_parent()
    if not clip_range:
        return False

    start_val = clip_range.start_time.value
    duration_val = clip_range.duration.value

    # Check if either the start time or duration are not whole numbers
    if not float(start_val).is_integer() or not float(duration_val).is_integer():
        return True

    return False


def edit_timeline_with_precalculated_instructions(
    otio_timeline_path: str,
    project_data: ProjectData,
    output_otio_path: str,
    remove_leading_gap: bool = True,
    use_api_for_subframe: bool = True,
) -> List[SubframeEditsData]:
    """
    Builds an edited timeline, preserving original inter-clip timing by default,
    while compacting segments within each clip.
    """
    if not globalz.PROJECT_DATA:
        raise ValueError("Failed to initialize project data.")

    api_jobs: List[SubframeEditsData] = []

    otio_data = load_otio_timeline_data(otio_timeline_path)
    original_timeline = otio_data["timeline"]
    timeline_rate = otio_data["rate"]
    global_start_offset_frames = otio_data["global_start_offset_frames"]

    logger.info(
        f"Starting timeline editing process. API for subframe: {use_api_for_subframe}."
    )

    catalog = _catalog_original_timeline_items(
        original_timeline, timeline_rate, global_start_offset_frames
    )
    group_source_data_map = build_group_source_data_map(
        project_data, original_timeline, catalog, global_start_offset_frames
    )

    time_shift_to_zero_start_rt = otio.opentime.RationalTime(0, timeline_rate)
    if remove_leading_gap:
        first_clip_start_rt = next(
            (rt for _, hint, _, rt in catalog["ordered_items"] if "clip" in hint), None
        )
        if first_clip_start_rt:
            global_start_rt = otio.opentime.RationalTime(
                global_start_offset_frames, timeline_rate
            )
            leading_gap_duration_rt = first_clip_start_rt - global_start_rt
            if leading_gap_duration_rt.value > 1e-9:
                logger.info(
                    f"Detected a leading gap of {leading_gap_duration_rt.value} frames. Shifting timeline."
                )
                time_shift_to_zero_start_rt = leading_gap_duration_rt

    new_timeline = otio_schema.Timeline(
        name=f"{original_timeline.name or 'Timeline'} - Pruner Edits",
        global_start_time=copy.deepcopy(original_timeline.global_start_time),
    )
    for orig_track in original_timeline.tracks:
        new_track = otio_schema.Track(name=orig_track.name, kind=orig_track.kind)
        new_timeline.tracks.append(new_track)

    new_track_cursors_relative_rt = [
        otio.opentime.RationalTime(0, new_timeline.global_start_time.rate)
        for _ in new_timeline.tracks
    ]
    max_orig_id = _get_max_original_link_group_id(original_timeline)
    next_link_group_id_for_main_loop = max_orig_id + 1

    for item_key, item_type_hint, _, original_item_abs_start_rt in catalog[
        "ordered_items"
    ]:
        if item_type_hint == "gap":
            continue

        instruction_tuples_for_group = group_source_data_map.get(item_key)
        original_otio_clips_for_this_group = catalog["clips_by_group_and_track"].get(
            item_key, defaultdict(lambda: None)
        )

        if not original_otio_clips_for_this_group or all(
            c is None for c in original_otio_clips_for_this_group.values()
        ):
            continue

        # This is the ANCHOR for the start of the edited block.
        group_target_start_on_new_timeline_rt = (
            original_item_abs_start_rt
            - otio.opentime.RationalTime(global_start_offset_frames, timeline_rate)
            - time_shift_to_zero_start_rt
        )

        if instruction_tuples_for_group:
            merged_sound_segments_on_orig_tl = (
                _generate_merged_edit_instructions_for_group(
                    item_key, instruction_tuples_for_group, catalog, timeline_rate
                )
            )
            json_items_in_this_group = [t[0] for t in instruction_tuples_for_group]
            next_id, new_api_jobs = _apply_merged_segments_to_new_timeline(
                item_key,
                merged_sound_segments_on_orig_tl,
                json_items_in_this_group,
                original_otio_clips_for_this_group,
                original_timeline,
                new_timeline,
                new_track_cursors_relative_rt,
                timeline_rate,
                group_target_start_on_new_timeline_rt,  # Pass the ANCHOR time
                next_link_group_id_for_main_loop,
                use_api_for_subframe,
            )
            next_link_group_id_for_main_loop = next_id
            if new_api_jobs:
                api_jobs.extend(new_api_jobs)
        else:
            # Unedited clips are placed at their original start time.
            _apply_unedited_clips_to_new_timeline(
                item_key,
                group_target_start_on_new_timeline_rt,
                original_otio_clips_for_this_group,
                new_timeline,
                new_track_cursors_relative_rt,
            )

    _pad_tracks_to_common_duration(new_timeline, new_track_cursors_relative_rt)
    otio.adapters.write_to_file(new_timeline, output_otio_path)
    logger.info(f"Generated OTIO timeline at: {output_otio_path}")
    print(f"Final edits for API: {api_jobs}")
    return api_jobs


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

# 22 loops, lol
