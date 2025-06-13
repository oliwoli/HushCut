import json
import logging
from typing import List, Dict, Tuple, Optional, cast

# Assuming these are correctly defined in your project
from local_types import (
    TimelineItem,
)
import globalz

# from pprint import pprint
# from misc_utils import export_to_json


def process_track_items(
    items: list,
    pd_timeline: dict,
    pd_timeline_key: str,
    timeline_start_rate: int,
    max_id: int = 0,
    track_index: int = 0,
) -> int:
    """
    First pass: Iterates through an OTIO track's children to find the
    corresponding items in the project data and assign the `link_group_id`.
    """
    FRAME_MATCH_TOLERANCE = 0.5
    playhead_frames = 0

    for item in items:
        if not item:
            continue
        item_schema = str(item.get("OTIO_SCHEMA", "")).lower()
        duration_val = item.get("source_range", {}).get("duration", {}).get("value", 0)

        if "gap" in item_schema:
            playhead_frames += duration_val
            continue

        if "clip" in item_schema:
            record_frame_float = playhead_frames
            corresponding_item = None
            for tl_item in pd_timeline.get(pd_timeline_key, []):
                if (
                    tl_item.get("track_index") == track_index
                    and abs(tl_item.get("start_frame", -1) - record_frame_float)
                    < FRAME_MATCH_TOLERANCE
                ):
                    corresponding_item = tl_item
                    break

            if not corresponding_item:
                logging.warning(
                    f"Could not find a corresponding project item for OTIO clip at frame {record_frame_float}"
                )
                playhead_frames += duration_val
                continue

            link_group_id = (
                item.get("metadata", {}).get("Resolve_OTIO", {}).get("Link Group ID")
            )
            if link_group_id is not None:
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
                track.get("children", []),
                pd_timeline,
                pd_key,
                timeline_rate,
                max_link_group_id,
                current_track_index,
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
    # export_to_json(globalz.PROJECT_DATA, debug_json_path)
