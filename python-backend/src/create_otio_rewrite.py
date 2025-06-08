import enum
import os
from turtle import pd
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
    Optional,
    DefaultDict,
    Set,
    Tuple,
    TypedDict,
    Union,
    Any,
)

from local_types import (
    ProjectData,
    EditInstruction,
    TimelineItem,
    Timeline as DavinciTimeline,
)
import globalz

import otio_types
from otio_types import Timeline

from pprint import pprint

from misc_utils import export_to_json


def merge_edit_instructions_from_items(
    items: List[TimelineItem],
) -> List[EditInstruction]:
    # Normalize all edit instructions to be relative to the source_start_frame of each item
    normalized: List[tuple[float, float]] = []

    for item in items:
        base = item["source_start_frame"]
        for edit in item["edit_instructions"]:
            rel_start = edit["source_start_frame"] - base
            rel_end = edit["source_end_frame"] - base
            normalized.append((rel_start, rel_end))

    if not normalized:
        return []

    # Sort by start, then merge overlapping or adjacent intervals
    normalized.sort()
    merged: List[tuple[float, float]] = []
    current_start, current_end = normalized[0]

    for start_source, end in normalized[1:]:
        if start_source <= current_end:  # Overlap or touch
            current_end = max(current_end, end)
        else:
            merged.append((current_start, current_end))
            current_start, current_end = start_source, end

    merged.append((current_start, current_end))

    # Reconstruct EditInstructions using only source-relative info
    return [
        {
            "source_start_frame": start,
            "source_end_frame": end,
            "start_frame": 0,  # placeholder
            "end_frame": 0,  # placeholder
            "enabled": True,
        }
        for start, end in merged
    ]


def merge_and_remap_edit_instructions(items: List[TimelineItem]) -> List[TimelineItem]:
    # Step 1: Normalize to source-relative time
    source_relative_edits: List[tuple[float, float]] = []

    for item in items:
        base = item["source_start_frame"]
        for edit in item["edit_instructions"]:
            rel_start = edit["source_start_frame"] - base
            rel_end = edit["source_end_frame"] - base
            source_relative_edits.append((rel_start, rel_end))

    if not source_relative_edits:
        return items  # Nothing to do

    # Step 2: Merge overlapping or adjacent ranges
    source_relative_edits.sort()
    merged: List[tuple[float, float]] = []
    current_start, current_end = source_relative_edits[0]

    for start, end in source_relative_edits[1:]:
        if start <= current_end:  # Overlap or touching
            current_end = max(current_end, end)
        else:
            merged.append((current_start, current_end))
            current_start, current_end = start, end

    merged.append((current_start, current_end))

    # Step 3: Remap back to each TimelineItem
    remapped_items: List[TimelineItem] = []

    for item in items:
        clip_start_src = item["source_start_frame"]
        clip_start_timeline = item["start_frame"]

        current_timeline_pos = clip_start_timeline
        new_edits: List[EditInstruction] = []

        for rel_src_start, rel_src_end in merged:
            abs_src_start = rel_src_start + clip_start_src
            abs_src_end = rel_src_end + clip_start_src
            duration = abs_src_end - abs_src_start
            timeline_end = current_timeline_pos + round(duration)

            new_edits.append(
                {
                    "source_start_frame": abs_src_start,
                    "source_end_frame": abs_src_end,
                    "start_frame": current_timeline_pos,
                    "end_frame": timeline_end,
                    "enabled": True,
                }
            )

            current_timeline_pos = timeline_end + 1.0

        new_item = item.copy()
        new_item["edit_instructions"] = new_edits
        remapped_items.append(new_item)

    return remapped_items


def add_float_to_rt(
    rt: otio.opentime.RationalTime, value: float
) -> otio.opentime.RationalTime:
    """
    Adds a float value to a RationalTime object, returning a new RationalTime.
    """
    new_value = rt.value + value
    return otio.opentime.RationalTime(value=new_value, rate=rt.rate)


def add_rt_to_rt(
    rt1: otio.opentime.RationalTime, rt2: otio.opentime.RationalTime
) -> otio.opentime.RationalTime:
    """
    Adds two RationalTime objects, returning a new RationalTime.
    """
    rt1_float = abs(rt1.to_frames())
    rt2_float = abs(rt2.to_frames())

    new_value = rt1_float + rt2_float
    new_rt: otio.opentime.RationalTime = otio.opentime.from_frames(
        new_value, rate=rt1.rate
    )
    return new_rt


def create_otio_from_project_data(input_otio_path: str, output_path: str) -> None:
    # save project data to json
    project_data: ProjectData | None = globalz.PROJECT_DATA
    if not project_data:
        raise ValueError("Could not initialize project data.")

    curr_dir = os.path.dirname(os.path.abspath(__file__))
    project_data_path = os.path.join(curr_dir, "project_data.json")
    export_to_json(project_data, project_data_path)

    # load the input OTIO file
    original_otio_obj = otio.adapters.read_from_file(input_otio_path)

    # load as json
    with open(input_otio_path, "r") as f:
        timeline: Timeline = json.load(f)

    print(timeline["global_start_time"])
    global_start_time = timeline["global_start_time"]

    tracks = timeline["tracks"]["children"]

    used_link_ids: Set[str] = set()
    # for item in project_data["timeline"]["video_track_items"]:
    #     track_idx = item["track_index"]
    #     otio_track = None
    #     for idx, track in enumerate(tracks):
    #         if not track.get("kind"):
    #             continue
    #         if track.get("kind") != "Video":
    #             continue
    #         if idx + 1 == track_idx:
    #             otio_track = track
    #             break
    #     if not otio_track:
    #         logging.error(
    #             f"Could not find track with index {track_idx} in OTIO tracks."
    #         )
    #         continue
    #     print(f"Processing track {track_idx} with name {otio_track['name']}")

    pd_timeline: DavinciTimeline = project_data["timeline"]

    max_link_group_id = 0

    # def add_group_id_to_items(track: )
    # video_items_by_track_index: DefaultDict[int, List[TimelineItem]] = defaultdict(list)
    # audio_items_by_track_index: DefaultDict[int, List[TimelineItem]] = defaultdict(list)

    # for item in pd_timeline["video_track_items"]:
    #     track_index = item["track_index"]
    #     video_items_by_track_index[track_index].append(item)
    # for item in pd_timeline["audio_track_items"]:
    #     track_index = item["track_index"]
    #     audio_items_by_track_index[track_index].append(item)

    def process_track_items(
        items: list[otio_types.Children],
        track_type,
        pd_timeline_key,
        start_time,
        max_id=0,
        track_index=0,
    ) -> int:
        playhead_rt: otio.opentime.RationalTime = otio.opentime.RationalTime(
            value=start_time["value"], rate=start_time["rate"]
        )
        for item in items:
            if not item:
                continue

            item_schema = str(item.get("OTIO_SCHEMA", "")).lower()
            item_name = item.get("name", "Unnamed")
            item_duration = item.get("source_range", {}).get("duration", {})
            item_duration_rt = otio.opentime.RationalTime(
                value=item_duration.get("value", 0),
                rate=item_duration.get("rate", start_time["rate"]),
            )
            item_start_frame: float = float(playhead_rt.to_frames())

            if "gap" in item_schema:
                playhead_rt = add_rt_to_rt(playhead_rt, item_duration_rt)
                continue

            if "clip" in item_schema:
                print(item_name)
                print(f"Item {item_name} starts at frame {item_start_frame}")
                # find the correct item by start frame
                corresponding_item = None
                for tl_item in pd_timeline[pd_timeline_key]:
                    if tl_item["track_index"] != track_index:
                        continue
                    if tl_item["start_frame"] == item_start_frame:
                        corresponding_item = tl_item
                        break

                if not corresponding_item:
                    playhead_rt = add_rt_to_rt(playhead_rt, item_duration_rt)
                    print(
                        f"Could not find corresponding item for {item_name} with start frame {item_start_frame} in PD timeline."
                    )
                    continue

                link_group_id = (
                    item.get("metadata", {})
                    .get("Resolve_OTIO", {})
                    .get("Link Group ID")
                )
                if not link_group_id:
                    logging_method = logging.error if track_type == "video" else print
                    logging_method(f"Item {item_name} does not have a link group ID.")
                    continue

                corresponding_item["link_group_id"] = link_group_id
                max_id = max(max_id, link_group_id)

                playhead_rt = add_rt_to_rt(playhead_rt, item_duration_rt)
        return max_id

    current_track_type: str = ""
    track_index: int = 0
    for track in tracks:
        kind = track.get("kind")
        if not kind:
            continue
        kind_lower = str(kind).lower()

        if kind_lower == "video":
            if current_track_type != "video":
                track_index = 1
                current_track_type = "video"
            max_link_group_id = process_track_items(
                track["children"],
                track_type="video",
                pd_timeline_key="video_track_items",
                start_time=global_start_time,
                max_id=max_link_group_id,
                track_index=track_index,  # Assuming track index starts at 1
            )

        elif kind_lower == "audio":
            if current_track_type != "audio":
                track_index = 1
                current_track_type = "audio"
            print(f"Processing audio track {track.get('name', 'Unnamed')}")
            max_link_group_id = process_track_items(
                track["children"],
                track_type="audio",
                pd_timeline_key="audio_track_items",
                start_time=global_start_time,
                max_id=max_link_group_id,
                track_index=track_index,  # Assuming track index starts at 1
            )
        elif kind_lower == "subtitle":
            if current_track_type != "subtitle":
                track_index = 1
                current_track_type = "subtitle"
        track_index += 1

    items_by_link_group: list[list[TimelineItem]] = []
    # pad the list by the highest link group id
    for _ in range(max_link_group_id + 1):
        items_by_link_group.append([])

    for item in pd_timeline["video_track_items"]:
        link_group_id = item.get("link_group_id")
        if link_group_id is None:
            continue
        items_by_link_group[link_group_id].append(item)

    for item in pd_timeline["audio_track_items"]:
        link_group_id = item.get("link_group_id")
        if link_group_id is None:
            continue
        items_by_link_group[link_group_id].append(item)

    print("Items by link group:", items_by_link_group)

    for id in range(len(items_by_link_group)):
        group = items_by_link_group[id]
        if not group:
            continue
        compare_combined_edits: List[EditInstruction] = []
        for item in group:
            edits = item["edit_instructions"]
            if not edits:
                continue
            compare_combined_edits.extend(edits)
        # sort the combined edits by start frame
        compare_combined_edits.sort(key=lambda x: x["start_frame"])
        print(f"combined edits before merge: {len(compare_combined_edits)}")
        pprint(compare_combined_edits)

        merged_edits = merge_edit_instructions_from_items(group)
        print("merged edits:", merged_edits)
        print(f"Link group {id} has {len(merged_edits)} edits")

        altered_group = merge_and_remap_edit_instructions(group)
        print("..... ALTERED GROUP .....")
        pprint(altered_group)

    print("video items", pd_timeline["video_track_items"])
    print("audio items", pd_timeline["audio_track_items"])

    # print(timeline["tracks"]["children"])

    # pprint(original_otio_obj)
