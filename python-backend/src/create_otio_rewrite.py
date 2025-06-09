import os
import opentimelineio as otio
import json
import logging
from typing import (
    Any,
    List,
    Dict,
    Tuple,
    TypedDict,
)
from copy import deepcopy

# Assuming these are correctly defined in your local project
from local_types import (
    ProjectData,
    EditInstruction,
    TimelineItem,
    Timeline as DavinciTimeline,
    make_empty_timeline_item,
)
import globalz
import otio_types
from otio_types import Timeline

from pprint import pprint
from misc_utils import export_to_json

# --- HELPER FUNCTIONS ---


def add_rt_to_rt(
    rt1: otio.opentime.RationalTime, rt2: otio.opentime.RationalTime
) -> otio.opentime.RationalTime:
    """Adds two RationalTime objects, returning a new RationalTime."""
    return rt1 + rt2


def process_track_items(
    items: list[otio_types.ClipOrGap],
    pd_timeline: DavinciTimeline,
    pd_timeline_key: str,
    start_time: otio_types.RationalTime,
    max_id: int = 0,
    track_index: int = 0,
) -> int:
    """
    First pass: Iterates through an OTIO track's children to find the
    corresponding items in the project data and assign the `link_group_id`.
    """
    FRAME_MATCH_TOLERANCE = 0.5

    playhead_rt = otio.opentime.RationalTime(
        value=start_time["value"], rate=start_time["rate"]
    )
    for item in items:
        if not item:
            continue

        item_schema = str(item.get("OTIO_SCHEMA", "")).lower()
        item_duration_dict = item.get("source_range", {}).get("duration", {})
        item_duration_rt = otio.opentime.RationalTime(
            value=item_duration_dict.get("value", 0),
            rate=item_duration_dict.get("rate", start_time["rate"]),
        )

        if "gap" in item_schema:
            playhead_rt += item_duration_rt
            continue

        if "clip" in item_schema:
            # record_frame = round(playhead_rt.to_frames())
            record_frame_float = playhead_rt.to_frames()

            corresponding_item = None
            for tl_item in pd_timeline[pd_timeline_key]:
                if (
                    tl_item["track_index"] == track_index
                    and abs(tl_item["start_frame"] - record_frame_float)
                    < FRAME_MATCH_TOLERANCE
                ):
                    corresponding_item = tl_item
                    break

            if not corresponding_item:
                print(f"could not find corresponding item for item {item}")
                playhead_rt += item_duration_rt
                continue

            link_group_id = (
                item.get("metadata", {}).get("Resolve_OTIO", {}).get("Link Group ID")
            )
            if link_group_id is not None:
                corresponding_item["link_group_id"] = link_group_id
                max_id = max(max_id, link_group_id)

            playhead_rt += item_duration_rt
    return max_id


def unify_edit_instructions(items: List[TimelineItem]) -> List[Tuple[float, float]]:
    """
    Takes a list of linked items, normalizes their edit instructions to be
    source-relative, and merges them into a single list of active time ranges.
    """
    normalized: List[Tuple[float, float]] = []
    for item in items:
        # source_start_frame is the frame count offset for this clip
        base = item["source_start_frame"]
        for edit in item["edit_instructions"]:
            rel_start = edit["source_start_frame"] - base
            rel_end = edit["source_end_frame"] - base
            normalized.append((rel_start, rel_end))

    if not normalized:
        return []

    normalized.sort()
    merged: List[Tuple[float, float]] = []
    if not normalized:
        return merged

    current_start, current_end = normalized[0]
    for next_start, next_end in normalized[1:]:
        if next_start <= current_end:
            current_end = max(current_end, next_end)
        else:
            merged.append((current_start, current_end))
            current_start, current_end = next_start, next_end
    merged.append((current_start, current_end))

    min_duration_in_frames = 1.0
    final_edits = []
    for start, end in merged:
        duration = end - start
        if duration >= min_duration_in_frames:
            final_edits.append((start, end))

    return final_edits


# --- MAIN LOGIC ---


def create_otio_from_project_data(input_otio_path: str, output_path: str) -> None:
    """
    Reads an OTIO file and project data, preserves original clip start times,
    and ripples edits within each clip, creating or adjusting gaps as needed.
    """
    project_data: ProjectData | None = globalz.PROJECT_DATA
    if not project_data:
        raise ValueError("Could not initialize project data.")
    pd_timeline: DavinciTimeline = project_data["timeline"]

    with open(input_otio_path, "r") as f:
        timeline: Timeline = json.load(f)

    original_tracks: list[otio_types.TrackChildren] = timeline["tracks"]["children"]
    max_link_group_id = 0
    track_type_counters = {"video": 0, "audio": 0, "subtitle": 0}
    for track in original_tracks:
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
                pd_timeline=pd_timeline,
                pd_timeline_key=pd_key,
                start_time=timeline["global_start_time"],
                max_id=max_link_group_id,
                track_index=current_track_index,
            ),
        )

    items_by_link_group: List[List[TimelineItem]] = [
        [] for _ in range(max_link_group_id + 1)
    ]
    for item in pd_timeline["video_track_items"] + pd_timeline["audio_track_items"]:
        link_group_id = item.get("link_group_id")
        if link_group_id is not None:
            items_by_link_group[link_group_id].append(item)

    next_new_group_id = max_link_group_id + 1
    all_pd_items = pd_timeline["video_track_items"] + pd_timeline["audio_track_items"]
    for item in all_pd_items:
        # If a clip wasn't assigned an ID but has edits, it's a standalone clip.
        if "link_group_id" not in item and item.get("edit_instructions"):
            # Assign it a new, unique ID.
            new_id = next_new_group_id
            item["link_group_id"] = new_id

            # Ensure the main list is large enough.
            while len(items_by_link_group) <= new_id:
                items_by_link_group.append([])

            # Add it as a new group containing only this item.
            items_by_link_group[new_id] = [item]
            next_new_group_id += 1

    # Update the max ID to reflect any new groups we added.
    max_link_group_id = next_new_group_id - 1
    # === END FIX ===

    # === PASS 3: Unify Edit Instructions ===
    unified_edits_by_group: Dict[int, List[Tuple[float, float]]] = {}
    for id, group in enumerate(items_by_link_group):
        if group:
            unified_edits_by_group[id] = unify_edit_instructions(group)

    class NewGroupInfo(TypedDict):
        group_id_range: Tuple[int, int]

    new_group_id_mapping: Dict[int, NewGroupInfo] = {}
    new_clip_id_counter = 1
    for original_id in sorted(unified_edits_by_group.keys()):
        num_new_clips = len(unified_edits_by_group[original_id])
        if num_new_clips == 0:
            continue
        new_group_id_mapping[original_id] = NewGroupInfo(
            group_id_range=(
                new_clip_id_counter,
                new_clip_id_counter + num_new_clips - 1,
            ),
        )
        new_clip_id_counter += num_new_clips

    # === PASS 4: Rebuild the timeline with the final "Anchor and Ripple" logic ===

    edited_timeline: Timeline = deepcopy(timeline)
    new_tracks_list = []

    rt_rate = timeline["global_start_time"]["rate"]
    global_start_time_rt = otio.opentime.RationalTime(
        value=timeline["global_start_time"]["value"], rate=rt_rate
    )

    FRAME_MATCH_TOLERANCE = 0.5

    rebuild_track_counters = {"video": 0, "audio": 0}
    for original_track in timeline["tracks"]["children"]:
        track_type = str(original_track.get("kind", "")).lower()
        if track_type not in rebuild_track_counters:
            new_tracks_list.append(deepcopy(original_track))
            continue

        rebuild_track_counters[track_type] += 1
        current_track_index = rebuild_track_counters[track_type]
        new_track_children: List[otio_types.ClipOrGap] = []

        initial_start_frame = round(global_start_time_rt.to_frames())
        new_timeline_playhead_frames = initial_start_frame
        original_timeline_playhead_frames = initial_start_frame

        for child_item in original_track.get("children", []):
            original_item_start_frames = original_timeline_playhead_frames
            duration_dict = child_item["source_range"]["duration"]
            original_duration_rt = otio.opentime.RationalTime(
                value=duration_dict["value"], rate=duration_dict["rate"]
            )
            original_item_duration_frames = round(original_duration_rt.to_frames())

            gap_duration_frames = (
                original_item_start_frames - new_timeline_playhead_frames
            )
            if gap_duration_frames > 0:
                gap_duration_rt = otio.opentime.from_frames(
                    gap_duration_frames, rt_rate
                )
                gap_dict = {
                    "OTIO_SCHEMA": "Gap.1",
                    "metadata": {},
                    "name": "Gap",
                    "source_range": {
                        "OTIO_SCHEMA": "TimeRange.1",
                        "duration": {
                            "OTIO_SCHEMA": "RationalTime.1",
                            "rate": gap_duration_rt.rate,
                            "value": gap_duration_rt.value,
                        },
                        "start_time": {
                            "OTIO_SCHEMA": "RationalTime.1",
                            "rate": rt_rate,
                            "value": 0.0,
                        },
                    },
                }
                new_track_children.append(gap_dict)
                new_timeline_playhead_frames += gap_duration_frames

            item_schema = str(child_item.get("OTIO_SCHEMA", "")).lower()

            if "clip" in item_schema:
                pd_key = f"{track_type}_track_items"
                corresponding_item = next(
                    (
                        item
                        for item in pd_timeline.get(pd_key, [])
                        if item["track_index"] == current_track_index
                        and abs(item["start_frame"] - original_item_start_frames)
                        < FRAME_MATCH_TOLERANCE
                    ),
                    None,
                )
                link_group_id = (
                    corresponding_item.get("link_group_id")
                    if corresponding_item
                    else None
                )
                unified_edits = (
                    unified_edits_by_group.get(link_group_id)
                    if link_group_id is not None
                    else None
                )

                if not unified_edits:
                    new_track_children.append(deepcopy(child_item))
                    new_timeline_playhead_frames += original_item_duration_frames
                else:
                    original_clip_source_start = corresponding_item[
                        "source_start_frame"
                    ]
                    id_map_info = new_group_id_mapping[link_group_id]

                    for i, (rel_start, rel_end) in enumerate(unified_edits):
                        new_item = deepcopy(child_item)
                        duration_frames = int(round(rel_end - rel_start + 1))

                        # --- THE FIX: Correct Source Time Calculation ---

                        # 1. Calculate the frame offset within the source media
                        abs_src_offset_frames = original_clip_source_start + rel_start

                        # 2. Get the base starting frame of the entire source media file
                        original_media_ref = child_item["media_references"][
                            "DEFAULT_MEDIA"
                        ]
                        base_timecode_frames = original_media_ref["available_range"][
                            "start_time"
                        ]["value"]

                        # 3. Add them together for the true absolute start frame
                        new_source_start_frames = (
                            base_timecode_frames + abs_src_offset_frames
                        )

                        # 4. Create time objects from the correct, absolute frame numbers
                        start_time_rt = otio.opentime.from_frames(
                            new_source_start_frames, rt_rate
                        )
                        duration_rt = otio.opentime.from_frames(
                            duration_frames, rt_rate
                        )

                        new_item["source_range"] = {
                            "OTIO_SCHEMA": "TimeRange.1",
                            "start_time": {
                                "OTIO_SCHEMA": "RationalTime.1",
                                "rate": start_time_rt.rate,
                                "value": start_time_rt.value,
                            },
                            "duration": {
                                "OTIO_SCHEMA": "RationalTime.1",
                                "rate": duration_rt.rate,
                                "value": duration_rt.value,
                            },
                        }
                        # --- END FIX ---

                        group_id_start = id_map_info["group_id_range"][0]
                        new_item["metadata"]["Resolve_OTIO"]["Link Group ID"] = (
                            group_id_start + i
                        )

                        new_track_children.append(new_item)
                        new_timeline_playhead_frames += duration_frames

            elif "gap" in item_schema:
                new_track_children.append(deepcopy(child_item))
                new_timeline_playhead_frames += original_item_duration_frames

            original_timeline_playhead_frames += original_item_duration_frames

        new_track = deepcopy(original_track)
        new_track["children"] = new_track_children
        new_tracks_list.append(new_track)

    edited_timeline["tracks"]["children"] = new_tracks_list
    export_to_json(data=edited_timeline, output_path=output_path)
