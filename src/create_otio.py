# make_edited_otio.py

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
# Direct import from main.py (or a shared types module)
# Assumes main.py is in the same directory or PYTHONPATH is configured.
from main import ProjectData
from main import (
    TimelineItem as JsonTimelineItem,
)  # Rename for clarity within this script's context
from main import EditInstruction
from main import Timeline as ProjectTimeline  # Rename for clarity

# Define OTIO-specific types and aliases
from opentimelineio import schema as otio_schema

TrackItemType = Union[
    otio_schema.Clip, otio_schema.Gap, otio_schema.Transition
]  # Add others if needed


class OriginalTimelineCatalog(TypedDict):
    ordered_items: List[
        Tuple[str, str, Optional[TrackItemType], otio.opentime.RationalTime]
    ]
    clips_by_group_and_track: DefaultDict[str, DefaultDict[int, otio_schema.Clip]]


class OtioTimelineData(TypedDict):
    timeline: otio.schema.Timeline
    rate: float
    global_start_offset_frames: float


EditInstructionsAndOtioContext = Tuple[List[EditInstruction], float]
GroupEditsMap = Dict[str, EditInstructionsAndOtioContext]

# --- Helper Functions ---


def _generate_otio_item_map_key(
    item: TrackItemType, track_idx_0_based: int, item_idx_in_track: int
) -> str:
    """Generates a consistent key for an OTIO item (Clip or Gap) for mapping purposes."""
    if isinstance(item, otio_schema.Gap):
        return f"gap_track{track_idx_0_based}_item{item_idx_in_track}"
    elif isinstance(item, otio_schema.Clip):
        link_id = item.metadata.get("Resolve_OTIO", {}).get("Link Group ID")
        if link_id is not None:
            return f"linkgroup_{link_id}"
        else:
            return f"unlinked_track{track_idx_0_based}_item{item_idx_in_track}"
    # Add elif for Transition or other types if needed
    else:
        logger.warning(
            f"Generating fallback key for unexpected item type: {type(item)}"
        )
        return f"unknown_track{track_idx_0_based}_item{item_idx_in_track}_{id(item)}"  # id() as last resort


def _derive_json_id_from_otio_clip(
    otio_clip: otio_schema.Clip,
    otio_track_kind_str: str,  # "audio" or "video" derived from otio_track.kind
    resolve_style_track_index: int,  # 1-based index parsed from otio_track.name
    original_start_frame_int: int,  # Absolute timeline start frame of this OTIO clip instance
) -> str:
    """
    Constructs a candidate JSON ID string from OTIO clip properties.
    Matches the format: ClipName-TrackType-ResolveTrackIndex--TimelineStartFrame.
    NOTE: Uses track type as the 'category' part, assuming this matches main.py.
    """
    # Use the track type string ("audio" or "video") as the category part
    item_category_for_id = otio_track_kind_str

    return f"{otio_clip.name}-{item_category_for_id}-{resolve_style_track_index}--{original_start_frame_int}"


# --- Core Logic Functions ---


def load_otio_timeline_data(otio_path: str) -> OtioTimelineData:
    """Loads OTIO timeline and extracts basic data."""
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
    """Loads the project data JSON file."""
    with open(json_path, "r") as f:
        # If types are imported, no cast needed unless JSON structure might deviate
        return json.load(f)


def _index_json_timeline_items(
    project_data: ProjectData,
) -> Dict[str, JsonTimelineItem]:
    """Creates a lookup dictionary for JsonTimelineItems keyed by their unique ID."""
    json_items_by_id: Dict[str, JsonTimelineItem] = {}
    all_json_timeline_items: List[JsonTimelineItem] = []

    # Assume project_data conforms to ProjectData type from main.py
    if project_data and project_data.get("timeline"):
        timeline_data = project_data["timeline"]
        audio_items = timeline_data.get("audio_track_items")
        video_items = timeline_data.get("video_track_items")
        if audio_items:
            all_json_timeline_items.extend(audio_items)
        if video_items:
            all_json_timeline_items.extend(video_items)

    for item in all_json_timeline_items:
        json_item_id = item.get("id")
        item_edit_instructions = item.get("edit_instructions")
        if json_item_id and isinstance(
            item_edit_instructions, list
        ):  # Only check if instructions is a list
            json_items_by_id[json_item_id] = item

    logger.info(f"Indexed {len(json_items_by_id)} JSON items by their ID.")
    return json_items_by_id


def _map_otio_to_json_edits(
    original_otio_timeline: otio_schema.Timeline,
    json_items_by_id: Dict[str, JsonTimelineItem],
    catalog: OriginalTimelineCatalog,
) -> GroupEditsMap:
    group_edits_map: GroupEditsMap = {}
    used_json_ids: Set[str] = set()

    logger.info(
        "Mapping OTIO items to JSON instructions using OTIO track names and ORIGINAL TIMELINE START FRAME..."
    )

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
        if len(parts) > 1 and parts[-1].isdigit():
            try:
                resolve_track_index_from_name = int(parts[-1])
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

            # --- FIX: Use category consistent with main.py's get_item_id ---
            # Assuming standard clips will have 'clip' category from main.py
            # If main.py detects fusion/compound, this might need adjustment,
            # but OTIO might not easily expose that distinction here.
            item_category_for_id = "clip"

            # Construct the candidate JSON ID using the CORRECT category
            otio_derived_json_id_candidate = _derive_json_id_from_otio_clip(
                otio_clip,
                current_otio_track_kind_str,
                resolve_track_index_from_name,
                original_start_frame_int,  # Pass the start frame
            )
            # --- UNCOMMENT FOR DEBUG ---
            logger.info(
                f"  OTIO Clip '{otio_clip.name}' (Key: {item_key_for_map}), trying derived JSON ID: '{otio_derived_json_id_candidate}'"
            )

            matched_json_item = json_items_by_id.get(otio_derived_json_id_candidate)
            if matched_json_item:
                json_instructions = matched_json_item.get("edit_instructions")
                if otio_derived_json_id_candidate in used_json_ids:
                    logger.warning(
                        f"JSON ID '{otio_derived_json_id_candidate}' already mapped..."
                    )
                    continue
                if json_instructions:
                    otio_clip_instance_abs_src_start = (
                        otio_clip.source_range.start_time.value
                    )
                    group_edits_map[item_key_for_map] = (
                        json_instructions,
                        otio_clip_instance_abs_src_start,
                    )
                    used_json_ids.add(otio_derived_json_id_candidate)
                    # logger.debug(f"Mapped OTIO Key '{item_key_for_map}' using JSON ID '{otio_derived_json_id_candidate}'.")
            # else:
            # logger.debug(f"FAIL: No JSON item found for derived ID '{otio_derived_json_id_candidate}'.")

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
    catalog: OriginalTimelineCatalog,  # Add catalog as parameter
) -> GroupEditsMap:
    """Builds the map associating OTIO item keys with their edit instructions and context."""
    json_items_by_id = _index_json_timeline_items(project_data)
    # Pass the catalog to the mapping function
    group_edits_map = _map_otio_to_json_edits(
        original_otio_timeline, json_items_by_id, catalog
    )
    return group_edits_map


def _catalog_original_timeline_items(
    original_timeline: otio_schema.Timeline,
    timeline_rate: float,
    global_start_offset_frames: float,
) -> OriginalTimelineCatalog:
    """Catalogs items from the original timeline, calculating their start times and grouping clips."""
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
            # Ensure item conforms to expected types before generating key
            if not isinstance(
                item_on_orig_track,
                (otio_schema.Clip, otio_schema.Gap, otio_schema.Transition),
            ):  # Extend if needed
                logger.warning(
                    f"Skipping unexpected item type {type(item_on_orig_track)} during cataloging."
                )
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
    # Cast the inner defaultdict type explicitly if needed by type checker strictness
    catalog_result: OriginalTimelineCatalog = {
        "ordered_items": ordered_items,
        "clips_by_group_and_track": clips_by_group_and_track,
    }
    return catalog_result


def _apply_edited_segments_to_new_timeline(
    item_key: str,
    edit_instructions: List[EditInstruction],
    otio_clip_instance_abs_src_start_offset: float,
    original_clips_for_group: DefaultDict[int, otio_schema.Clip],
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    global_start_offset_frames: float,
    next_link_group_id: int,
) -> int:
    """Applies segments based on EditInstructions to the new timeline."""
    logger.debug(
        f"Applying {len(edit_instructions)} edit instructions for item key '{item_key}'"
    )

    for instr in edit_instructions:
        if not instr.get("enabled", False):
            continue

        segment_abs_tl_start_frame = instr["start_frame"]
        segment_abs_tl_end_frame_inclusive = instr["end_frame"]
        target_placement_start_relative_rt = otio.opentime.RationalTime(
            segment_abs_tl_start_frame - global_start_offset_frames, timeline_rate
        )

        segment_src_start_relative_to_instance = instr["source_start_frame"]
        segment_src_end_relative_to_instance_inclusive = instr["source_end_frame"]
        true_abs_source_start_frame = (
            otio_clip_instance_abs_src_start_offset
            + segment_src_start_relative_to_instance
        )
        true_abs_source_end_frame_inclusive = (
            otio_clip_instance_abs_src_start_offset
            + segment_src_end_relative_to_instance_inclusive
        )
        source_duration_frames = (
            true_abs_source_end_frame_inclusive - true_abs_source_start_frame + 1
        )

        if source_duration_frames <= 1e-9:
            continue

        final_clip_source_start_rt = otio.opentime.RationalTime(
            true_abs_source_start_frame, timeline_rate
        )
        final_clip_source_duration_rt = otio.opentime.RationalTime(
            source_duration_frames, timeline_rate
        )

        current_segment_link_id = next_link_group_id

        for track_idx_orig, original_clip_to_clone in original_clips_for_group.items():
            if track_idx_orig >= len(new_timeline.tracks):
                continue

            # Clone the original clip - rely on OTIO clone to handle effects/markers
            new_segment_item = original_clip_to_clone.clone()

            # Set the correct source range for this segment
            new_segment_item.source_range = otio.opentime.TimeRange(
                start_time=final_clip_source_start_rt,
                duration=final_clip_source_duration_rt,
            )

            # Set new Link Group ID in metadata
            if "Resolve_OTIO" not in new_segment_item.metadata:
                new_segment_item.metadata["Resolve_OTIO"] = {}
            new_segment_item.metadata["Resolve_OTIO"][
                "Link Group ID"
            ] = current_segment_link_id

            # Add to the target track with necessary gap
            target_track = new_timeline.tracks[track_idx_orig]
            gap_needed = (
                target_placement_start_relative_rt
                - new_track_cursors_relative_rt[track_idx_orig]
            )
            if gap_needed.value > 1e-9:
                target_track.append(otio_schema.Gap(duration=gap_needed))
            target_track.append(new_segment_item)

            # Update cursor for this track
            new_track_cursors_relative_rt[track_idx_orig] = (
                target_placement_start_relative_rt + final_clip_source_duration_rt
            )

        next_link_group_id += 1

    return next_link_group_id


def _apply_unedited_clips_to_new_timeline(
    item_key: str,
    original_item_abs_start_rt: otio.opentime.RationalTime,
    original_clips_for_group: DefaultDict[int, otio_schema.Clip],
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
    timeline_rate: float,
    global_start_offset_frames: float,
) -> None:
    """Copies original clips for an unedited group to the new timeline at their original position."""
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

        # Clone the original clip - rely on OTIO clone for metadata, effects, markers
        cloned_clip = original_clip_to_copy.clone()
        target_track.append(cloned_clip)

        # Update cursor for this track
        new_track_cursors_relative_rt[track_idx_orig] = (
            target_placement_start_relative_rt + cloned_clip.duration()
        )


def _pad_tracks_to_common_duration(
    new_timeline: otio_schema.Timeline,
    new_track_cursors_relative_rt: List[otio.opentime.RationalTime],
) -> None:
    """Adds trailing gaps to make all tracks in the new timeline the same duration."""
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
    project_data: ProjectData,
    output_otio_path: str,
) -> None:
    """
    Edits an OTIO timeline based on precalculated instructions from project data JSON.
    """
    original_timeline = otio_data["timeline"]
    timeline_rate = otio_data["rate"]
    global_start_offset_frames = otio_data["global_start_offset_frames"]

    new_timeline = otio_schema.Timeline(
        name=f"{original_timeline.name or 'Timeline'} - Edits Applied",
        global_start_time=copy.deepcopy(original_timeline.global_start_time),
    )
    for _ in original_timeline.tracks:  # Create corresponding new tracks
        # Cloning original track structure might bring unwanted effects/markers if they exist at track level
        # Let's create empty tracks first, then copy necessary track metadata if needed later.
        # For now, assume track metadata isn't critical for this operation.
        # Find kind from original to replicate
        orig_track = original_timeline.tracks[len(new_timeline.tracks)]
        new_timeline.tracks.append(
            otio_schema.Track(name=orig_track.name, kind=orig_track.kind)
        )

    catalog = _catalog_original_timeline_items(
        original_timeline, timeline_rate, global_start_offset_frames
    )
    ordered_items = catalog["ordered_items"]
    original_clips_by_group_and_track = catalog["clips_by_group_and_track"]

    # 2. Build the map from OTIO group/item keys to edit instructions, USING the catalog
    group_edits_context_map = build_group_edits_map(
        project_data, original_timeline, catalog
    )

    # 3. Create the new timeline structure
    new_timeline = otio_schema.Timeline(
        name=f"{original_timeline.name or 'Timeline'} - Edits Applied",
        global_start_time=copy.deepcopy(original_timeline.global_start_time),
    )
    for orig_track in original_timeline.tracks:
        new_timeline.tracks.append(
            otio_schema.Track(name=orig_track.name, kind=orig_track.kind)
        )

    new_track_cursors_relative_rt: List[otio.opentime.RationalTime] = [
        otio.opentime.RationalTime(0, timeline_rate) for _ in new_timeline.tracks
    ]
    next_link_group_id = 1

    for (
        item_key,
        item_type_hint,
        original_item_object,
        original_item_abs_start_rt,
    ) in ordered_items:
        if item_type_hint == "gap":
            continue

        group_edit_context = group_edits_context_map.get(item_key)
        original_clips_for_group = original_clips_by_group_and_track.get(
            item_key, defaultdict(otio_schema.Clip)
        )

        if group_edit_context:
            edit_instructions, otio_src_start_offset = group_edit_context
            enabled_instructions_exist = any(
                instr.get("enabled", False) for instr in edit_instructions
            )

            if enabled_instructions_exist:
                next_link_group_id = _apply_edited_segments_to_new_timeline(
                    item_key,
                    edit_instructions,
                    otio_src_start_offset,
                    original_clips_for_group,
                    new_timeline,
                    new_track_cursors_relative_rt,
                    timeline_rate,
                    global_start_offset_frames,
                    next_link_group_id,
                )
            else:
                _apply_unedited_clips_to_new_timeline(
                    item_key,
                    original_item_abs_start_rt,
                    original_clips_for_group,
                    new_timeline,
                    new_track_cursors_relative_rt,
                    timeline_rate,
                    global_start_offset_frames,
                )
        else:
            _apply_unedited_clips_to_new_timeline(
                item_key,
                original_item_abs_start_rt,
                original_clips_for_group,
                new_timeline,
                new_track_cursors_relative_rt,
                timeline_rate,
                global_start_offset_frames,
            )

    _pad_tracks_to_common_duration(new_timeline, new_track_cursors_relative_rt)

    otio.adapters.write_to_file(new_timeline, output_otio_path)
    logger.info(f"Edited OTIO timeline saved to: {output_otio_path}")


# --- Main Execution Block ---
if __name__ == "__main__":
    current_dir = os.path.dirname(os.path.abspath(__file__))
    otio_input_path = os.path.join(current_dir, "pre-edit_timeline_export.otio")
    project_json_path = os.path.join(current_dir, "silence_detections.json")
    otio_output_path = os.path.join(current_dir, "edited_timeline_refactored.otio")
    logging.getLogger().setLevel(logging.INFO)

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
        logger.error(
            f"Failed to import types from main.py. Ensure main.py is accessible or install dependencies."
        )
        logger.error(f"ImportError: {e}")
        exit(1)
    except Exception as e:
        logger.exception(
            f"An unexpected error occurred during timeline processing:"
        )  # Log full traceback
        exit(1)
