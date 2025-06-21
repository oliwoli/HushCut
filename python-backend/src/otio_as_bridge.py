import json
import logging
import os
from typing import List, Dict, Tuple, Optional, cast

# Assuming these are correctly defined in your project
from local_types import TimelineItem, NestedAudioTimelineItem
import globalz

# from pprint import pprint
from misc_utils import export_to_json


def _create_nested_audio_item_from_otio(
    otio_clip: dict, clip_start_in_container: float
) -> Optional[NestedAudioTimelineItem]:
    """
    Parses an OTIO clip from within a nested timeline (like a compound clip)
    and converts it into a NestedAudioTimelineItem dictionary.

    Args:
        otio_clip: The dictionary representing the OTIO clip.
        clip_start_in_container: The frame number where this clip starts inside its container.

    Returns:
        A NestedAudioTimelineItem dictionary or None if the item is not a valid audio source.
    """
    media_refs = otio_clip.get("media_references", {})
    if not media_refs:
        return None

    active_media_key = otio_clip.get("active_media_reference_key", "DEFAULT_MEDIA")
    media_ref = media_refs.get(active_media_key)

    if not media_ref or not str(media_ref.get("OTIO_SCHEMA", "")).lower().startswith(
        "externalreference"
    ):
        return None

    source_path_uri = media_ref.get("target_url", "")
    if not source_path_uri:
        return None

    if source_path_uri.startswith("file://"):
        source_file_path = os.path.normpath(source_path_uri[7:])
    else:
        source_file_path = os.path.normpath(source_path_uri)

    source_range = otio_clip.get("source_range")
    available_range = media_ref.get("available_range")

    if not source_range or not available_range:
        return None

    # FIXED: Normalize the source start frame. The OTIO source_range is absolute to the
    # original source media's timeline. We subtract the available_range's start time
    # to get a value relative to the beginning of the media file, which is what the
    # silence detection process expects.
    clip_source_start_val = source_range.get("start_time", {}).get("value", 0.0)
    media_available_start_val = available_range.get("start_time", {}).get("value", 0.0)

    normalized_source_start_frame = clip_source_start_val - media_available_start_val
    duration = source_range.get("duration", {}).get("value", 0.0)
    normalized_source_end_frame = normalized_source_start_frame + duration

    start_frame_in_container = clip_start_in_container
    end_frame_in_container = start_frame_in_container + duration

    nested_item: NestedAudioTimelineItem = {
        "source_file_path": source_file_path,
        "processed_file_name": None,
        "start_frame": start_frame_in_container,
        "end_frame": end_frame_in_container,
        "source_start_frame": normalized_source_start_frame,
        "source_end_frame": normalized_source_end_frame,
        "duration": duration,
        "edit_instructions": [],
    }
    return nested_item


def _recursive_otio_parser(otio_composable: Dict) -> List[NestedAudioTimelineItem]:
    """
    (REVISED) Recursively traverses an OTIO composable (like a Stack) and returns a list
    of all audio clips found within its audio tracks.
    """
    found_clips: List[NestedAudioTimelineItem] = []

    # The children of a Stack are Tracks. We iterate through them.
    for track in otio_composable.get("children", []):
        # We only care about audio tracks.
        if track.get("kind", "").lower() != "audio":
            continue

        # Now we are inside an audio track, look for clips.
        playhead = 0.0
        for item_in_track in track.get("children", []):
            schema = str(item_in_track.get("OTIO_SCHEMA", "")).lower()
            duration = (
                (item_in_track.get("source_range") or {})
                .get("duration", {})
                .get("value", 0.0)
            )

            if "gap" in schema:
                playhead += duration
                continue

            if "clip" in schema:
                item = _create_nested_audio_item_from_otio(item_in_track, playhead)
                if item:
                    found_clips.append(item)

            # This handles cases where there are stacks inside tracks inside stacks...
            elif "stack" in schema:
                found_clips.extend(
                    _recursive_otio_parser(item_in_track)
                )  # Recurse on the nested stack

            playhead += duration

    return found_clips


def populate_nested_clips(input_otio_path: str) -> None:
    """
    Reads an OTIO file to find container clips (like Compounds), finds all nested
    audio, and populates the `nested_clips` list for ALL corresponding items
    (video and audio) in the global project data.
    """
    project_data = globalz.PROJECT_DATA
    if not project_data or "timeline" not in project_data:
        logging.error(
            "Cannot populate nested clips: globalz.PROJECT_DATA is not configured."
        )
        return

    try:
        with open(input_otio_path, "r") as f:
            otio_data = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        logging.error(f"Failed to read or parse OTIO file at {input_otio_path}: {e}")
        return

    # --- 1. First Pass: Parse all unique compound clips and map their contents ---
    nested_audio_by_sequence_id: Dict[str, List[NestedAudioTimelineItem]] = {}

    for track in otio_data.get("tracks", {}).get("children", []):
        for item in track.get("children", []):
            item_schema = str(item.get("OTIO_SCHEMA", "")).lower()
            if "stack" in item_schema:
                sequence_id = (
                    item.get("metadata", {}).get("Resolve_OTIO", {}).get("Sequence ID")
                )
                if sequence_id and sequence_id not in nested_audio_by_sequence_id:
                    # Parse this unique compound clip once and store its nested audio.
                    nested_audio_by_sequence_id[sequence_id] = _recursive_otio_parser(
                        item
                    )

    pd_timeline = project_data["timeline"]
    # --- 2. Second Pass: Apply the found nested clips to our project data items ---
    all_pd_items = pd_timeline.get("video_track_items", []) + pd_timeline.get(
        "audio_track_items", []
    )

    timeline_start_frame = float(
        otio_data.get("global_start_time", {}).get("value", 0.0)
    )
    FRAME_MATCH_TOLERANCE = 0.5

    for track in otio_data.get("tracks", {}).get("children", []):
        playhead_frames = 0
        for item in track.get("children", []):
            duration_val = (
                (item.get("source_range") or {}).get("duration", {}).get("value", 0.0)
            )
            item_schema = str(item.get("OTIO_SCHEMA", "")).lower()

            if "gap" in item_schema:
                playhead_frames += duration_val
                continue

            if "stack" in item_schema:
                sequence_id = (
                    item.get("metadata", {}).get("Resolve_OTIO", {}).get("Sequence ID")
                )
                nested_clips_for_this_sequence = nested_audio_by_sequence_id.get(
                    sequence_id
                )

                # If we found nested audio for this compound clip...
                if nested_clips_for_this_sequence:
                    record_frame_float = playhead_frames + timeline_start_frame

                    # ...find all project data items that correspond to it...
                    corresponding_pd_items = [
                        pd_item
                        for pd_item in all_pd_items
                        if pd_item.get("type") in {"Compound", "Multicam"}
                        and abs(pd_item.get("start_frame", -1) - record_frame_float)
                        < FRAME_MATCH_TOLERANCE
                    ]

                    # ...and apply the same list of nested clips to all of them.
                    for pd_item in corresponding_pd_items:
                        pd_item["nested_clips"] = nested_clips_for_this_sequence

            playhead_frames += duration_val


def process_track_items(
    items: list,
    pd_timeline: dict,
    pd_timeline_key: str,
    timeline_start_rate: int,
    timeline_start_frame: float = 0.0,
    max_id: int = 0,
    track_index: int = 0,
) -> int:
    """
    (REVISED) First pass: Iterates through an OTIO track's children to find the
    corresponding items in the project data and assign the `link_group_id`.
    Now handles both Clips and Stacks (Compound Clips).
    """
    FRAME_MATCH_TOLERANCE = 0.5
    playhead_frames = 0

    for item in items:
        if not item:
            continue
        item_schema = str(item.get("OTIO_SCHEMA", "")).lower()
        duration_val = (
            (item.get("source_range") or {}).get("duration", {}).get("value", 0)
        )

        if "gap" in item_schema:
            playhead_frames += duration_val
            continue

        # MODIFIED: Treat Clips and Stacks the same for finding link IDs.
        if "clip" in item_schema or "stack" in item_schema:
            record_frame_float = playhead_frames + timeline_start_frame

            # Find all project data items that correspond to this OTIO item.
            # A compound clip will match both its video and audio parts.
            corresponding_items = [
                tl_item
                for tl_item in pd_timeline.get(pd_timeline_key, [])
                if tl_item.get("track_index") == track_index
                and abs(tl_item.get("start_frame", -1) - record_frame_float)
                < FRAME_MATCH_TOLERANCE
            ]

            if not corresponding_items:
                logging.warning(
                    f"Could not find a corresponding project item for OTIO item at frame {record_frame_float} on track {track_index}"
                )
                playhead_frames += duration_val
                continue

            link_group_id = (
                item.get("metadata", {}).get("Resolve_OTIO", {}).get("Link Group ID")
            )

            if link_group_id is not None:
                # Apply the found link ID to all matching items.
                for corresponding_item in corresponding_items:
                    corresponding_item["link_group_id"] = link_group_id
                max_id = max(max_id, link_group_id)

            playhead_frames += duration_val

    return max_id


def unify_edit_instructions(
    items: List[TimelineItem],
) -> List[Tuple[float, Optional[float]]]:
    """
    Takes a list of linked items, finds all defined edit instructions,
    normalizes them to be source-relative, and merges them into a single list
    of active time ranges.

    If no items have edit instructions, it returns a special signal `[(0.0, None)]`
    to indicate the group is uncut.
    """
    has_any_edits = any(item.get("edit_instructions") for item in items)

    if not has_any_edits:
        return [(0.0, None)]

    normalized: List[Tuple[float, float]] = []
    for item in items:
        if item.get("edit_instructions"):
            base = item.get("source_start_frame", 0.0)
            for edit in item["edit_instructions"]:
                # Ensure edits are valid before processing
                if (
                    edit.get("source_start_frame") is not None
                    and edit.get("source_end_frame") is not None
                ):
                    rel_start = edit["source_start_frame"] - base
                    rel_end = edit["source_end_frame"] - base
                    normalized.append((rel_start, rel_end))

    if not normalized:  # Handle case where edits existed but were invalid
        return []

    normalized.sort()
    merged: List[Tuple[float, float]] = []

    current_start, current_end = normalized[0]

    for next_start, next_end in normalized[1:]:
        # Merge overlapping or contiguous intervals
        if next_start <= current_end + 0.01:  # Add tolerance for float precision
            current_end = max(current_end, next_end)
        else:
            merged.append((current_start, current_end))
            current_start, current_end = next_start, next_end
    merged.append((current_start, current_end))

    min_duration_in_frames = 1.0
    final_edits = [
        (start, end) for start, end in merged if (end - start) >= min_duration_in_frames
    ]

    return final_edits


def unify_linked_items_in_project_data(input_otio_path: str) -> None:
    """
    Reads an OTIO file to find linked clips, unifies their edit instructions
    based on a discrete frame grid, and overwrites the project data.
    This ensures perfect sync and no gaps between edited clips.
    """
    project_data = getattr(globalz, "PROJECT_DATA", None)
    if not project_data or "timeline" not in project_data:
        logging.error("Could not initialize or find project data.")
        raise ValueError("globalz.PROJECT_DATA is not properly configured.")

    pd_timeline = project_data["timeline"]

    try:
        with open(input_otio_path, "r") as f:
            otio_data = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        logging.error(f"Failed to read or parse OTIO file at {input_otio_path}: {e}")
        return

    max_link_group_id = 0
    track_type_counters = {"video": 0, "audio": 0, "subtitle": 0}
    timeline_rate = otio_data.get("global_start_time", {}).get("rate", 24)
    start_time_value = otio_data.get("global_start_time", {}).get("value", 0.0)
    timeline_start_frame = float(start_time_value)
    for track in otio_data.get("tracks", {}).get("children", []):
        kind = str(track.get("kind", "")).lower()
        if kind not in track_type_counters:
            continue
        track_type_counters[kind] += 1
        current_track_index = track_type_counters[kind]
        pd_key = f"{kind}_track_items"
        max_link_group_id = max(
            max_link_group_id,
            process_track_items(
                items=track.get("children", []),
                pd_timeline=pd_timeline,
                pd_timeline_key=pd_key,
                timeline_start_rate=timeline_rate,
                timeline_start_frame=timeline_start_frame,
                max_id=max_link_group_id,
                track_index=current_track_index,
            ),
        )

    all_pd_items = pd_timeline.get("video_track_items", []) + pd_timeline.get(
        "audio_track_items", []
    )

    # for item in all_pd_items:
    #     if item.get("type") == "Compound" and item.get("nested_clips"):
    #         print("PROCESSING COMPOUND CLIP")
    #         # Unify the edit instructions from all nested clips.
    #         unified_nested_edits = unify_edit_instructions(item["nested_clips"])
    #         print(f"unified nested edits: {unified_nested_edits}")
    #         # The compound clip now inherits these unified edits.
    #         # We treat the compound clip as its own source, so source start/end is 0.
    #         base_source_offset = 0.0
    #         new_edit_instructions = []

    #         if unified_nested_edits and unified_nested_edits[0][1] is not None:
    #             for rel_start, rel_end in unified_nested_edits:
    #                 if not rel_end:
    #                     continue
    #                 duration = rel_end - rel_start
    #                 if duration < 1:
    #                     continue
    #                 new_edit_instructions.append(
    #                     {
    #                         "source_start_frame": base_source_offset + rel_start,
    #                         "source_end_frame": base_source_offset + rel_end,
    #                         "start_frame": 0,  # Placeholder, will be calculated later
    #                         "end_frame": 0,  # Placeholder, will be calculated later
    #                         "enabled": True,
    #                     }
    #                 )
    #         else:  # Handle uncut case
    #             new_edit_instructions.append(
    #                 {
    #                     "source_start_frame": item["source_start_frame"],
    #                     "source_end_frame": item["source_end_frame"],
    #                     "start_frame": item["start_frame"],
    #                     "end_frame": item["end_frame"],
    #                     "enabled": True,
    #                 }
    #             )

    #         item["edit_instructions"] = new_edit_instructions
    #         logging.info(f"Unified nested edits for Compound Clip: {item['id']}")

    items_by_link_group: Dict[int, List[Dict]] = {}
    for item in all_pd_items:
        link_group_id = item.get("link_group_id")
        if link_group_id is not None:
            items_by_link_group.setdefault(link_group_id, []).append(item)

    next_new_group_id = max_link_group_id + 1
    for item in all_pd_items:
        if "link_group_id" not in item and item.get("edit_instructions"):
            item["link_group_id"] = next_new_group_id
            items_by_link_group[next_new_group_id] = [item]
            next_new_group_id += 1

    for link_id, group_items in items_by_link_group.items():
        if not group_items:
            continue

        unified_edits = unify_edit_instructions(group_items)

        original_enabled_flag = True
        for g_item in group_items:
            if g_item.get("edit_instructions"):
                original_enabled_flag = g_item["edit_instructions"][0].get(
                    "enabled", True
                )
                break

        group_timeline_anchor = min(
            (item.get("start_frame", float("inf")) for item in group_items),
            default=float("inf"),
        )
        if group_timeline_anchor == float("inf"):
            logging.warning(
                f"Could not determine a start frame for link group {link_id}. Skipping."
            )
            continue

        is_uncut = not unified_edits or (unified_edits and unified_edits[0][1] is None)

        for item in group_items:
            new_edit_instructions = []
            base_source_offset = item.get("source_start_frame", 0.0)

            if is_uncut:
                # Uncut groups use their original, unmodified timings.
                source_end = item.get("source_end_frame", base_source_offset)
                if source_end > base_source_offset:
                    new_edit_instructions.append(
                        {
                            "source_start_frame": base_source_offset,
                            "source_end_frame": source_end,
                            "start_frame": item.get("start_frame"),
                            "end_frame": item.get("end_frame"),
                            "enabled": True,
                        }
                    )
            else:
                # Initialize a cumulative playhead on a rounded frame grid.
                timeline_playhead = round(group_timeline_anchor)

                for rel_start, rel_end in unified_edits:
                    source_duration = cast(float, rel_end) - rel_start
                    timeline_duration = round(source_duration)

                    if timeline_duration < 1:
                        continue

                    source_start = base_source_offset + rel_start
                    # Adjust source_end to match the integer timeline duration.
                    source_end = source_start + timeline_duration

                    timeline_start = timeline_playhead
                    timeline_end = timeline_playhead + timeline_duration

                    new_edit_instructions.append(
                        {
                            "source_start_frame": source_start,
                            "source_end_frame": source_end,
                            "start_frame": timeline_start,
                            "end_frame": timeline_end,
                            "enabled": original_enabled_flag,
                        }
                    )

                    # Advance the playhead by the exact integer duration.
                    timeline_playhead = timeline_end

            item["edit_instructions"] = new_edit_instructions
            logging.info(
                f"Updated item '{item['id']}' in group {link_id} with {len(new_edit_instructions)} unified edit(s)."
            )

    # current_dir = os.path.dirname(os.path.abspath(__file__))
    # debug_json_path = os.path.join(current_dir, "debug_project_data.json")
    # print(f"exporting to {debug_json_path}")
    # export_to_json(globalz.PROJECT_DATA, debug_json_path)
