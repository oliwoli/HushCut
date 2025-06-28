import json
import logging
import os
import re
from typing import Any, List, Dict, Tuple, Optional, cast

# Assuming these are correctly defined in your project
from hushcut_lib.local_types import TimelineItem, NestedAudioTimelineItem
from hushcut_lib import globalz

# from pprint import pprint
from hushcut_lib.misc_utils import uuid_from_path


def _create_nested_audio_item_from_otio(
    otio_clip: Dict[str, Any],
    clip_start_in_container: float,
    max_duration: Optional[float] = None,
) -> Optional[NestedAudioTimelineItem]:
    """
    (REVISED) Parses an OTIO clip and now also extracts specific
    audio channel mapping information from its metadata.
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

    source_uuid = uuid_from_path(source_file_path).hex

    source_range = otio_clip.get("source_range")
    available_range = media_ref.get("available_range")
    if not source_range or not available_range:
        return None

    clip_source_start_val = source_range.get("start_time", {}).get("value", 0.0)
    media_available_start_val = available_range.get("start_time", {}).get("value", 0.0)

    normalized_source_start_frame = clip_source_start_val - media_available_start_val
    duration = source_range.get("duration", {}).get("value", 0.0)

    if max_duration is not None and duration > max_duration:
        duration = max_duration

    # --- NEW LOGIC to extract channel data and determine processed filename ---
    source_channel = 0  # Default to 0 for mono mixdown
    processed_file_name = f"{source_uuid}.wav"  # Default filename

    resolve_meta = otio_clip.get("metadata", {}).get("Resolve_OTIO", {})
    channels_info = resolve_meta.get("Channels", [])

    # Heuristic: If the clip is mapped to exactly one source track/channel,
    # assume it's a specific channel extraction, not a mixdown.
    if len(channels_info) == 1:
        # "Source Track ID" corresponds to the 1-indexed channel number.
        channel_num = channels_info[0].get("Source Track ID")
        if isinstance(channel_num, int) and channel_num > 0:
            source_channel = channel_num
            processed_file_name = f"{source_uuid}_ch{source_channel}.wav"
            logging.info(
                f"OTIO parser: Found mapping for clip '{otio_clip.get('name')}' to source channel {source_channel}"
            )
    # --- END NEW LOGIC ---

    nested_item: NestedAudioTimelineItem = {
        "source_file_path": source_file_path,
        "processed_file_name": processed_file_name,  # Use the calculated name
        "source_channel": source_channel + 1,  # Add the channel number
        "start_frame": clip_start_in_container,
        "end_frame": clip_start_in_container + duration,
        "source_start_frame": normalized_source_start_frame,
        "source_end_frame": normalized_source_start_frame + duration,
        "duration": duration,
        "edit_instructions": [],
    }
    return nested_item


def _recursive_otio_parser(
    otio_composable: Dict[str, Any],
    active_angle_name: Optional[str] = None,
    container_duration: Optional[float] = None,
) -> List[NestedAudioTimelineItem]:
    """
    Recursively traverses an OTIO composable, respecting both Multicam
    active angles and container duration constraints.
    """
    found_clips: List[NestedAudioTimelineItem] = []

    for track in otio_composable.get("children", []):
        if track.get("kind", "").lower() != "audio":
            continue

        # FIX 2: For Multicam clips, only process the single active audio track.
        if active_angle_name and track.get("name") != active_angle_name:
            continue

        playhead = 0.0
        for item_in_track in track.get("children", []):
            if container_duration is not None and playhead >= container_duration:
                break

            schema = str(item_in_track.get("OTIO_SCHEMA", "")).lower()
            item_duration = (
                (item_in_track.get("source_range") or {})
                .get("duration", {})
                .get("value", 0.0)
            )

            effective_duration = item_duration
            if container_duration is not None:
                remaining_time = container_duration - playhead
                if item_duration > remaining_time:
                    effective_duration = max(0, remaining_time)

            if "gap" in schema:
                playhead += item_duration
                continue

            if effective_duration <= 0:
                playhead += item_duration
                continue

            if "clip" in schema:
                item = _create_nested_audio_item_from_otio(
                    item_in_track, playhead, max_duration=effective_duration
                )
                if item:
                    found_clips.append(item)

            elif "stack" in schema:
                # Pass both constraints down in the recursion.
                nested_clips = _recursive_otio_parser(
                    item_in_track,
                    active_angle_name=active_angle_name,
                    container_duration=effective_duration,
                )
                for nested_clip in nested_clips:
                    nested_clip["start_frame"] += playhead
                    nested_clip["end_frame"] += playhead
                    found_clips.append(nested_clip)

            playhead += item_duration

    return found_clips


def populate_nested_clips(input_otio_path: str) -> None:
    """
    Reads an OTIO file and populates nested clip data. This version combines
    all fixes: single-pass processing, specific item matching, and multicam angle detection.
    """
    project_data = globalz.PROJECT_DATA
    if not project_data or "timeline" not in project_data:
        logging.error(
            "Cannot populate nested clips: globalz.PROJECT_DATA is not configured."
        )
        return

    try:
        with open(input_otio_path, "r", encoding="utf-8") as f:
            otio_data = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        logging.error(f"Failed to read or parse OTIO file at {input_otio_path}: {e}")
        return

    pd_timeline = project_data["timeline"]
    all_pd_items = pd_timeline.get("video_track_items", []) + pd_timeline.get(
        "audio_track_items", []
    )
    timeline_start_frame = float(
        otio_data.get("global_start_time", {}).get("value", 0.0)
    )
    FRAME_MATCH_TOLERANCE = 0.5
    audio_track_counter = 0

    for track in otio_data.get("tracks", {}).get("children", []):
        if track.get("kind", "").lower() != "audio":
            continue

        audio_track_counter += 1
        current_track_index = audio_track_counter

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
                container_duration = duration_val

                # FIX 2 (RESTORED): Check for multicam clips and get active angle.
                resolve_meta = item.get("metadata", {}).get("Resolve_OTIO", {})
                sequence_type = resolve_meta.get("Sequence Type")
                active_angle_name = None
                if sequence_type == "Multicam Clip":
                    item_name = item.get("name", "")
                    match = re.search(r"Angle \d+", item_name)
                    if match:
                        active_angle_name = match.group(0)
                        logging.info(
                            f"Detected Multicam clip. Active audio angle: '{active_angle_name}'"
                        )
                    else:
                        logging.warning(
                            f"Could not parse active angle from Multicam name: '{item_name}'."
                        )

                nested_clips_for_this_instance = _recursive_otio_parser(
                    item,
                    active_angle_name=active_angle_name,
                    container_duration=container_duration,
                )

                if nested_clips_for_this_instance:
                    record_frame_float = playhead_frames + timeline_start_frame
                    otio_item_name = item.get("name")

                    # FIX 3: Use high-specificity matching to prevent data collision.
                    corresponding_pd_items = [
                        pd_item
                        for pd_item in all_pd_items
                        if (
                            pd_item.get("type")
                            and pd_item.get("track_index") == current_track_index
                            and abs(pd_item.get("start_frame", -1) - record_frame_float)
                            < FRAME_MATCH_TOLERANCE
                            and pd_item.get("name") == otio_item_name
                        )
                    ]

                    if not corresponding_pd_items:
                        logging.warning(
                            f"Could not find corresponding project item for OTIO stack '{otio_item_name}' on track {current_track_index}"
                        )

                    for pd_item in corresponding_pd_items:
                        pd_item["nested_clips"] = nested_clips_for_this_instance

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
) -> List[Tuple[float, Optional[float], bool]]:
    """
    Takes a list of linked items and unifies their edit instructions. It flattens
    all intervals, preserving their enabled/disabled state, and merges them
    such that any region covered by at least one 'enabled' clip is marked as enabled.
    """
    has_any_edits = any(item.get("edit_instructions") for item in items)
    if not has_any_edits:
        return [(0.0, None, True)]

    events = []
    for item in items:
        if item.get("edit_instructions"):
            base = item.get("source_start_frame", 0.0)
            for edit in item["edit_instructions"]:
                if (
                    edit.get("source_start_frame") is not None
                    and edit.get("source_end_frame") is not None
                ):
                    rel_start = edit["source_start_frame"] - base
                    rel_end = edit["source_end_frame"] - base
                    is_enabled = edit.get("enabled", True)
                    # --- CHANGE: Create start/end "event points" with enabled status ---
                    # Type: 1 for start, -1 for end
                    events.append((rel_start, 1, is_enabled))
                    events.append((rel_end, -1, is_enabled))

    if not events:
        return []

    # Sort events by frame time, then by type (starts before ends)
    events.sort(key=lambda x: (x[0], -x[1]))

    merged_segments = []
    active_enabled_count = 0
    active_disabled_count = 0
    last_frame = events[0][0]

    for frame, type_val, is_enabled in events:
        segment_duration = frame - last_frame
        if segment_duration > 0:
            # Determine the status of the time segment we just passed
            is_segment_enabled = active_enabled_count > 0
            is_segment_active = active_enabled_count > 0 or active_disabled_count > 0
            if is_segment_active:
                merged_segments.append((last_frame, frame, is_segment_enabled))

        if type_val == 1:  # Start of a clip
            if is_enabled:
                active_enabled_count += 1
            else:
                active_disabled_count += 1
        else:  # End of a clip
            if is_enabled:
                active_enabled_count -= 1
            else:
                active_disabled_count -= 1

        last_frame = frame

    if not merged_segments:
        return []

    final_edits = []
    current_start, current_end, current_enabled = merged_segments[0]

    for next_start, next_end, next_enabled in merged_segments[1:]:
        # If the next segment is contiguous and has the same status, merge it
        if next_start == current_end and next_enabled == current_enabled:
            current_end = next_end  # Extend the end time
        else:
            # Otherwise, finalize the current segment and start a new one
            final_edits.append((current_start, current_end, current_enabled))
            current_start, current_end, current_enabled = (
                next_start,
                next_end,
                next_enabled,
            )

    # Append the very last processed segment
    final_edits.append((current_start, current_end, current_enabled))

    min_duration_in_frames = 1.0
    return [
        (start, end, enabled)
        for start, end, enabled in final_edits
        if (end - start) >= min_duration_in_frames
    ]


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
        with open(input_otio_path, "r", encoding="utf-8") as f:
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

        # This function now returns the correctly processed, granular edit data
        unified_edits = unify_edit_instructions(group_items)

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
                source_end = item.get("source_end_frame", base_source_offset)
                if source_end > base_source_offset:
                    is_item_enabled = bool(
                        item.get("edit_instructions")
                        and item["edit_instructions"][0].get("enabled", True)
                    )
                    new_edit_instructions.append(
                        {
                            "source_start_frame": base_source_offset,
                            "source_end_frame": source_end,
                            "start_frame": item.get("start_frame"),
                            "end_frame": item.get("end_frame"),
                            "enabled": is_item_enabled,
                        }
                    )
            else:
                timeline_playhead = round(group_timeline_anchor)

                # Unpack the correct boolean for each specific segment
                for rel_start, rel_end, is_enabled in unified_edits:
                    source_duration = cast(float, rel_end) - rel_start
                    timeline_duration = round(source_duration)

                    if timeline_duration < 1:
                        continue

                    source_start = base_source_offset + rel_start
                    source_end = source_start + timeline_duration

                    timeline_start = timeline_playhead
                    timeline_end = timeline_playhead + timeline_duration

                    new_edit_instructions.append(
                        {
                            "source_start_frame": source_start,
                            "source_end_frame": source_end,
                            "start_frame": timeline_start,
                            "end_frame": timeline_end,
                            "enabled": is_enabled,  # Use the correct, granular flag
                        }
                    )
                    timeline_playhead = timeline_end

            item["edit_instructions"] = new_edit_instructions
            logging.info(
                f"Updated item '{item['id']}' in group {link_id} with {len(new_edit_instructions)} unified edit(s)."
            )

    # current_dir = os.path.dirname(os.path.abspath(__file__))
    # debug_json_path = os.path.join(current_dir, "debug_project_data.json")
    # print(f"exporting to {debug_json_path}")
    # export_to_json(globalz.PROJECT_DATA, debug_json_path)
