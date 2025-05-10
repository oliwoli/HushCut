# make_edited_otio.py

from collections.abc import Mapping
import time
import opentimelineio as otio
import json
import os
import copy
import math
import logging
from collections import defaultdict
from typing import (
    List,
    Dict,
    Optional,
    DefaultDict,
    Set,
    Tuple,
    Any,
    TypedDict,
    Union,
    cast,
)

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# --- Type Definitions ---
try:
    from main import ProjectData
    from main import TimelineItem as JsonTimelineItem
    from main import EditInstruction
    from main import Timeline as ProjectTimeline

    logger.info("Successfully imported types from main.py")
except ImportError:
    logger.error("CRITICAL: Could not import types from main.py.", exc_info=True)
    exit(1)

from opentimelineio import schema as otio_schema

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
) -> Dict[str, JsonTimelineItem]:
    # (Implementation is correct)
    json_items_by_id: Dict[str, JsonTimelineItem] = {}
    all_json_timeline_items: List[JsonTimelineItem] = []
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
    logger.info(f"Indexed {len(json_items_by_id)} JSON items by their ID.")
    return json_items_by_id


def _map_otio_to_json_edits(
    original_otio_timeline: otio_schema.Timeline,
    json_items_by_id: Dict[str, JsonTimelineItem],
    catalog: OriginalTimelineCatalog,
) -> GroupEditsMap:  # Returns Dict[str, List[EditInstruction]]
    # (Implementation is correct - uses ID matching)
    group_edits_map: GroupEditsMap = {}
    used_json_ids: Set[str] = set()
    logger.info("Mapping OTIO items to JSON instructions using derived IDs...")
    original_start_times_by_item_key: Dict[str, otio.opentime.RationalTime] = {
        item_key: start_time for item_key, _, _, start_time in catalog["ordered_items"]
    }

    for otio_track_idx_0_based, otio_track in enumerate(original_otio_timeline.tracks):
        otio_track_name = otio_track.name
        current_otio_track_kind_str = "unknown"
        resolve_track_index_from_name = 0
        if otio_track.kind == otio_schema.TrackKind.Audio:
            current_otio_track_kind_str = "audio"
        elif otio_track.kind == otio_schema.TrackKind.Video:
            current_otio_track_kind_str = "video"
        else:
            continue
        parts = otio_track_name.split(" ")
        index_part = parts[-1]
        if len(parts) > 1 and index_part.isdigit():
            try:
                resolve_track_index_from_name = int(index_part)
            except ValueError:
                pass
        if resolve_track_index_from_name == 0:
            continue

        for otio_item_idx_in_track, otio_clip_or_item in enumerate(otio_track):
            if not isinstance(otio_clip_or_item, otio_schema.Clip):
                continue
            otio_clip = otio_clip_or_item
            item_key_for_map = _generate_otio_item_map_key(
                otio_clip, otio_track_idx_0_based, otio_item_idx_in_track
            )
            if item_key_for_map in group_edits_map:
                continue
            original_abs_start_rt = original_start_times_by_item_key.get(
                item_key_for_map
            )
            if original_abs_start_rt is None:
                continue
            original_start_frame_int = int(round(original_abs_start_rt.value))

            otio_derived_json_id_candidate = _derive_json_id_from_otio_clip(
                otio_clip,
                current_otio_track_kind_str,
                resolve_track_index_from_name,
                original_start_frame_int,
            )
            matched_json_item = json_items_by_id.get(otio_derived_json_id_candidate)

            if matched_json_item:
                json_instructions = matched_json_item.get("edit_instructions")
                if otio_derived_json_id_candidate in used_json_ids:
                    continue
                if json_instructions:
                    group_edits_map[item_key_for_map] = (
                        json_instructions  # Store only instructions list
                    )
                    used_json_ids.add(otio_derived_json_id_candidate)

    if not group_edits_map:
        logger.warning("group_edits_map is empty.")
    else:
        logger.info(
            f"Successfully mapped {len(group_edits_map)} OTIO items/groups to edit instructions."
        )
    return group_edits_map


def build_group_edits_map(
    project_data: ProjectData,
    original_otio_timeline: otio_schema.Timeline,
    catalog: OriginalTimelineCatalog,
) -> GroupEditsMap:
    # (Implementation is correct)
    json_items_by_id = _index_json_timeline_items(project_data)
    group_edits_map = _map_otio_to_json_edits(
        original_otio_timeline, json_items_by_id, catalog
    )
    return group_edits_map


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
    logger.info(
        f"Cataloged {len(ordered_items)} unique items/groups from original timeline."
    )
    catalog_result: OriginalTimelineCatalog = {
        "ordered_items": ordered_items,
        "clips_by_group_and_track": clips_by_group_and_track,
    }
    return catalog_result


# --- CORRECTED Apply Edited Segments ---
def _apply_edited_segments_to_new_timeline(
    item_key: str,
    edit_instructions: EditInstructionsList,
    original_clips_for_group: DefaultDict[int, otio_schema.Clip],
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    global_start_offset_frames: float,
    next_link_group_id: int,
) -> int:

    logger.info(
        f"Inside _apply_edited_segments for '{item_key}'. Received initial next_link_group_id: {next_link_group_id}. Instructions: {len(edit_instructions)}"
    )

    current_id_for_this_groups_segments = next_link_group_id
    if not edit_instructions:
        return current_id_for_this_groups_segments

    involved_track_indices = [
        idx
        for idx, clip in original_clips_for_group.items()
        if clip
        and isinstance(clip, otio_schema.Clip)
        and idx < len(new_track_cursors_relative_rt)
    ]
    if not involved_track_indices:
        logger.error(
            f"Cannot apply edits for {item_key}: No valid original clips/track indices."
        )
        return current_id_for_this_groups_segments

    # --- Pre-Sync Cursors ---
    max_cursor_rt_before_group = otio.opentime.RationalTime(0, timeline_rate)
    for idx in involved_track_indices:
        max_cursor_rt_before_group = max(
            max_cursor_rt_before_group, new_track_cursors_relative_rt[idx]
        )
    logger.info(
        f"  Syncing cursors for tracks {involved_track_indices} to max: {max_cursor_rt_before_group.value}"
    )
    for idx in involved_track_indices:
        sync_gap_needed = (
            max_cursor_rt_before_group - new_track_cursors_relative_rt[idx]
        )
        if sync_gap_needed.value > 1e-9:
            target_track_instance = new_timeline.tracks[idx]
            logger.info(
                f"    Inserting pre-sync Gap duration {sync_gap_needed.value} on track idx {idx}"
            )
            target_track_instance.append(otio_schema.Gap(duration=sync_gap_needed))
            new_track_cursors_relative_rt[idx] = max_cursor_rt_before_group
    # --- Cursors Synced ---

    # Get representative clip info
    valid_original_clips = [
        original_clips_for_group[idx] for idx in involved_track_indices
    ]
    representative_original_clip = valid_original_clips[0]
    media_ref = representative_original_clip.media_reference
    available_range_start_frame_offset = 0.0
    if (
        media_ref
        and isinstance(media_ref, otio_schema.ExternalReference)
        and media_ref.available_range
        and media_ref.available_range.start_time
    ):
        available_range_start_frame_offset = float(
            media_ref.available_range.start_time.value
        )
    logger.debug(
        f"  MediaRef Start Offset: {available_range_start_frame_offset} for {item_key}"
    )

    last_segment_end_rt_on_all_tracks = max_cursor_rt_before_group

    for instr_idx, instr in enumerate(edit_instructions):
        if instr_idx == 0:
            instr_start_frame = instr["start_frame"]
            rt_target_placement = otio.opentime.RationalTime(
                instr_start_frame - global_start_offset_frames, timeline_rate
            )
            logger.info(
                f"  Segment {instr_idx} (FIRST): Target Placement = {rt_target_placement.value}"
            )
        else:
            rt_target_placement = last_segment_end_rt_on_all_tracks
            logger.info(
                f"  Segment {instr_idx}: Contiguous Target Placement = {rt_target_placement.value}"
            )

        # Calculate source range
        instr_source_start = instr["source_start_frame"]
        instr_source_end = instr["source_end_frame"]
        true_abs_source_start_frame = (
            available_range_start_frame_offset + instr_source_start
        )
        true_abs_source_end_frame_inclusive = (
            available_range_start_frame_offset + instr_source_end
        )
        source_duration_frames = (
            true_abs_source_end_frame_inclusive - true_abs_source_start_frame + 1
        )
        if source_duration_frames <= 1e-9:
            continue
        rt_source_start_in_media = otio.opentime.RationalTime(
            true_abs_source_start_frame, timeline_rate
        )
        rt_source_duration_in_media = otio.opentime.RationalTime(
            source_duration_frames, timeline_rate
        )

        current_segment_link_id_to_assign = current_id_for_this_groups_segments
        logger.info(
            f"    Assigning Link ID: {current_segment_link_id_to_assign}. Source Dur: {rt_source_duration_in_media.value}"
        )

        processed_on_this_segment_at_least_one_track = False
        segment_end_time_this_iteration = None

        for track_idx_orig in involved_track_indices:
            original_clip_to_clone = original_clips_for_group[track_idx_orig]
            target_track_instance = new_timeline.tracks[track_idx_orig]

            current_cursor_before_segment = new_track_cursors_relative_rt[
                track_idx_orig
            ]
            logger.debug(
                f"      Track {track_idx_orig}: Cursor BEFORE segment = {current_cursor_before_segment.value}"
            )

            # Determine actual start time for the segment on this track
            actual_segment_start_time = current_cursor_before_segment
            gap_needed_for_placement = (
                rt_target_placement - current_cursor_before_segment
            )

            logger.debug(
                f"        Target placement = {rt_target_placement.value}, Gap needed = {gap_needed_for_placement.value}"
            )

            if gap_needed_for_placement.value > 1e-9:
                logger.info(
                    f"        Inserting placement Gap dur {gap_needed_for_placement.value} on track idx {track_idx_orig}"
                )
                target_track_instance.append(
                    otio_schema.Gap(duration=gap_needed_for_placement)
                )
                actual_segment_start_time = (
                    rt_target_placement  # It will start exactly at the target
                )
            elif gap_needed_for_placement.value < -1e-9:
                logger.warning(
                    f"        Overlap! Target {rt_target_placement.value} < Cursor {current_cursor_before_segment.value}. Segment will start at {current_cursor_before_segment.value}"
                )
                # actual_segment_start_time remains current_cursor_before_segment

            # Create and append the new item
            new_segment_item = original_clip_to_clone.clone()
            new_segment_item.source_range = otio.opentime.TimeRange(
                start_time=rt_source_start_in_media,
                duration=rt_source_duration_in_media,
            )
            new_segment_item.enabled = instr.get("enabled", True)
            if "Resolve_OTIO" not in new_segment_item.metadata:
                new_segment_item.metadata["Resolve_OTIO"] = {}
            new_segment_item.metadata["Resolve_OTIO"][
                "Link Group ID"
            ] = current_segment_link_id_to_assign
            target_track_instance.append(new_segment_item)
            logger.debug(
                f"        Appended clip '{new_segment_item.name}' dur {rt_source_duration_in_media.value}"
            )

            # --- CORRECTED CURSOR UPDATE ---
            # The new cursor is the ACTUAL start time + the ACTUAL duration of the appended clip
            current_segment_end_rt = (
                actual_segment_start_time + rt_source_duration_in_media
            )
            new_track_cursors_relative_rt[track_idx_orig] = current_segment_end_rt
            # --- END CORRECTED CURSOR UPDATE ---

            logger.info(
                f"      Appended segment to track idx {track_idx_orig}. New cursor: {current_segment_end_rt.value}"
            )  # Log the calculated end time

            if segment_end_time_this_iteration is None:
                segment_end_time_this_iteration = current_segment_end_rt
            elif (
                abs((segment_end_time_this_iteration - current_segment_end_rt).value)
                > 1e-7
            ):
                logger.error(
                    f"      CURSOR DESYNC DETECTED on track {track_idx_orig}! Expected end {segment_end_time_this_iteration.value}, got {current_segment_end_rt.value}"
                )

            processed_on_this_segment_at_least_one_track = True

        if segment_end_time_this_iteration is not None:
            last_segment_end_rt_on_all_tracks = segment_end_time_this_iteration

        if processed_on_this_segment_at_least_one_track:
            current_id_for_this_groups_segments += 1
        else:
            logger.warning(
                f"  Segment {instr_idx} for '{item_key}' resulted in no clips added."
            )

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
    logger.info(f"Padding tracks to common relative duration: {max_duration_rt.value}")
    for i, track_to_pad in enumerate(new_timeline.tracks):
        gap_needed_rt = max_duration_rt - new_track_cursors_relative_rt[i]
        if gap_needed_rt.value > 1e-9:
            track_to_pad.append(otio_schema.Gap(duration=gap_needed_rt))


# --- Main Editing Function (Orchestrator) ---
def edit_timeline_with_precalculated_instructions(
    otio_data: OtioTimelineData,
    project_data: ProjectData,  # Assuming ProjectData is your defined type
    output_otio_path: str,
) -> None:
    """Edits an OTIO timeline based on precalculated instructions from project data JSON."""
    original_timeline = otio_data["timeline"]
    timeline_rate = otio_data["rate"]
    global_start_offset_frames = otio_data["global_start_offset_frames"]

    logger.info(
        "Starting timeline editing process (Main Orchestrator)."
    )  # Added context

    catalog = _catalog_original_timeline_items(
        original_timeline, timeline_rate, global_start_offset_frames
    )
    group_edits_map: GroupEditsMap = build_group_edits_map(
        project_data, original_timeline, catalog
    )

    new_timeline = otio_schema.Timeline(
        name=f"{original_timeline.name or 'Timeline'} - Edits Applied",
        global_start_time=copy.deepcopy(original_timeline.global_start_time),
    )
    logger.info(
        f"Created new timeline: '{new_timeline.name}' with global start: {new_timeline.global_start_time}"
    )  # Added global start log

    for orig_track_idx, orig_track in enumerate(
        original_timeline.tracks
    ):  # Added index for logging
        new_track = otio_schema.Track(name=orig_track.name, kind=orig_track.kind)
        new_timeline.tracks.append(new_track)
        logger.debug(
            f"  Copied track structure for original track {orig_track_idx}: '{orig_track.name}' ({orig_track.kind}) to new track: '{new_track.name}'"
        )  # Changed to DEBUG
    logger.info(f"Copied {len(new_timeline.tracks)} track structures to new timeline.")

    ordered_items = catalog["ordered_items"]
    original_clips_by_group_and_track = catalog["clips_by_group_and_track"]

    # Ensure new_track_cursors_relative_rt uses the rate from the new_timeline's global_start_time
    # which should be a copy of the original's.
    current_timeline_rate_for_cursors = timeline_rate  # Default
    if new_timeline.global_start_time and new_timeline.global_start_time.rate > 0:
        current_timeline_rate_for_cursors = new_timeline.global_start_time.rate
    else:
        logger.warning(
            f"New timeline global_start_time or its rate is invalid. Falling back to original timeline_rate ({timeline_rate}) for cursors."
        )

    new_track_cursors_relative_rt: List[otio.opentime.RationalTime] = [
        otio.opentime.RationalTime(0, current_timeline_rate_for_cursors)
        for _ in new_timeline.tracks
    ]

    max_orig_id = _get_max_original_link_group_id(
        original_timeline
    )  # This function is now silent or minimally logging
    next_link_group_id_for_main_loop = (
        max_orig_id + 1
    )  # Renamed for clarity in this scope
    logger.info(
        f"Max original Link Group ID found: {max_orig_id}. "
        f"Initializing next_link_group_id_for_main_loop to: {next_link_group_id_for_main_loop}"
    )

    logger.info(
        f"Initial new_track_cursors_relative_rt: {[c.value for c in new_track_cursors_relative_rt]} (Rate: {current_timeline_rate_for_cursors})"
    )

    for (
        item_key,
        item_type_hint,
        original_item_object,  # This is the OTIO item itself from the original timeline catalog
        original_item_abs_start_rt,
    ) in ordered_items:

        logger.info(
            f"Processing item_key: '{item_key}' of type '{item_type_hint}' starting at original abs time {original_item_abs_start_rt.value}"
        )
        # Log cursors before *any* processing for this item_key
        logger.info(
            f"  Track cursors BEFORE processing '{item_key}': {[c.value for c in new_track_cursors_relative_rt]}"
        )

        if item_type_hint == "gap":
            logger.debug(
                f"  Item '{item_key}' is a cataloged gap object. Current logic skips direct edit/clone for these. Cursors unchanged by this item."
            )
            # If these gaps from catalog.ordered_items *should* advance time or place actual gaps,
            # that logic would need to be added here.
            # For now, assuming they are just placeholders in the sorted list of original items.
            continue

        edit_instructions_for_group = group_edits_map.get(item_key)
        # Using defaultdict(lambda: None) to avoid issues with uninitialized Clip objects if key is missing.
        # Your original fallback was defaultdict(otio_schema.Clip), which could be problematic.
        original_clips_for_group = original_clips_by_group_and_track.get(
            item_key, defaultdict(lambda: None)
        )

        # Log details about original_clips_for_group
        if (
            not original_clips_for_group
        ):  # Check if the defaultdict is empty (e.g. item_key not in original_clips_by_group_and_track)
            logger.warning(
                f"  For item_key '{item_key}', original_clips_by_group_and_track.get() returned an empty group. This might be an issue in cataloging or item_key generation if item_key is expected to have clips."
            )
        else:
            logger.info(
                f"  For item_key '{item_key}', original_clips_for_group has {len(original_clips_for_group)} potential members on tracks: {list(original_clips_for_group.keys())}"
            )
            valid_clips_in_group_count = 0
            for tr_idx_orig, clp_in_group in original_clips_for_group.items():
                if clp_in_group and isinstance(
                    clp_in_group, otio_schema.Clip
                ):  # Ensure it's a real clip
                    logger.debug(
                        f"    Original Track {tr_idx_orig}: Clip '{clp_in_group.name}' (Duration: {clp_in_group.duration().value if clp_in_group.duration() else 'N/A'})"
                    )
                    valid_clips_in_group_count += 1
                elif (
                    clp_in_group is not None
                ):  # It's something, but not a clip as expected by defaultdict(otio_schema.Clip)
                    logger.warning(
                        f"    Original Track {tr_idx_orig}: Unexpected object in group: {type(clp_in_group)}"
                    )
                # If clp_in_group is None (from defaultdict(lambda:None)), no log here, handled by valid_clips_in_group_count
            if valid_clips_in_group_count == 0 and item_type_hint != "gap":
                logger.warning(
                    f"  No *valid* original clips found in original_clips_for_group for item_key '{item_key}', but it's not a gap. Skipping."
                )
                continue

        if (
            edit_instructions_for_group is not None
        ):  # This means key was in group_edits_map. Value could be []
            if not edit_instructions_for_group:
                logger.info(
                    f"  For '{item_key}', edit_instructions list IS PRESENT BUT EMPTY. Processing with _apply_edited_segments."
                )
            else:
                logger.info(
                    f"  For '{item_key}', found {len(edit_instructions_for_group)} edit instructions."
                )

            logger.info(
                f"  Calling _apply_edited_segments_to_new_timeline for '{item_key}' with current next_link_group_id = {next_link_group_id_for_main_loop}"
            )
            next_link_group_id_for_main_loop = _apply_edited_segments_to_new_timeline(
                item_key=item_key,
                edit_instructions=edit_instructions_for_group,
                original_clips_for_group=original_clips_for_group,  # Pass the (potentially empty) defaultdict
                new_timeline=new_timeline,
                new_track_cursors_relative_rt=new_track_cursors_relative_rt,
                timeline_rate=timeline_rate,
                global_start_offset_frames=global_start_offset_frames,
                next_link_group_id=next_link_group_id_for_main_loop,
            )
            logger.info(
                f"  _apply_edited_segments_to_new_timeline for '{item_key}' returned. Main loop's next_link_group_id is now: {next_link_group_id_for_main_loop}"
            )
        else:  # item_key was NOT in group_edits_map
            logger.info(
                f"  For '{item_key}', NO edit instructions found (key not in group_edits_map). Treating as unedited."
            )
            logger.info(
                f"  Calling _apply_unedited_clips_to_new_timeline for '{item_key}'"
            )
            _apply_unedited_clips_to_new_timeline(
                item_key,
                original_item_abs_start_rt,
                original_clips_for_group,  # Pass the (potentially empty) defaultdict
                new_timeline,
                new_track_cursors_relative_rt,
                timeline_rate,
                global_start_offset_frames,
            )
            logger.info(
                f"  _apply_unedited_clips_to_new_timeline for '{item_key}' completed."
            )

        # Log cursors after *all* processing for this item_key
        logger.info(
            f"  Track cursors AFTER processing '{item_key}': {[c.value for c in new_track_cursors_relative_rt]}"
        )

    _pad_tracks_to_common_duration(new_timeline, new_track_cursors_relative_rt)
    otio.adapters.write_to_file(new_timeline, output_otio_path)
    logger.info(f"Edited OTIO timeline saved to: {output_otio_path}")
    logger.info(
        "Timeline editing process finished (Main Orchestrator)."
    )  # Added context


# --- Main Execution Block ---
if __name__ == "__main__":
    # (Implementation is correct)
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

    try:
        otio_data_loaded = load_otio_timeline_data(otio_input_path)
        project_data_content: ProjectData = load_project_data(project_json_path)
        edit_timeline_with_precalculated_instructions(
            otio_data_loaded, project_data_content, otio_output_path
        )
        logger.info("Timeline editing process finished successfully.")
    except ImportError as e:
        logger.error(f"Failed to import types from main.py.", exc_info=True)
        exit(1)
    except Exception as e:
        logger.exception(f"An unexpected error occurred:")
        exit(1)
    end_time = time.time()
    elapsed_time = end_time - start_time
    print(f"Elapsed time: {elapsed_time:.2f} seconds")
