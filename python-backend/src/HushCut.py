#!/usr/bin/env python3

from __future__ import annotations
from collections import Counter
import json
import http.client
from http.client import HTTPConnection
from http.server import HTTPServer, BaseHTTPRequestHandler

import signal
import socket
import threading
from time import time, sleep
import traceback
from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict, cast, Sequence

import logging
import re
import os
import sys
import subprocess
import argparse
from concurrent.futures import ThreadPoolExecutor
import atexit
import urllib.parse
import uuid
import copy
from subprocess import CompletedProcess


# GLOBALS
SCRIPT_DIR = os.path.dirname(os.path.abspath(sys.argv[0]))
TEMP_DIR: str = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "wav_files")
TEMP_DIR = os.path.abspath(TEMP_DIR)
if not os.path.exists(TEMP_DIR):
    os.makedirs(TEMP_DIR)
PROJECT = None
TIMELINE = None
MEDIA_POOL = None

# This will be the token Go sends, which Python expects for Go-to-Python commands (future)
AUTH_TOKEN = None
ENABLE_COMMAND_AUTH = False  # Master switch for auth on Python's command server
GO_SERVER_PORT = 0
PYTHON_LISTEN_PORT = 0
SERVER_INSTANCE_HOLDER = []
SHUTDOWN_EVENT = threading.Event()

STANDALONE_MODE = False
RESOLVE = None
FFMPEG = "ffmpeg"
MAKE_NEW_TIMELINE = True
MAX_RETRIES = 100
created_timelines = {}


def uuid_from_path(path: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, path)


def uuid4() -> uuid.UUID:
    return uuid.uuid4()


def sec_to_frames(seconds: float, fps: float) -> float:
    """Converts time in seconds to frame number using ceiling."""
    if fps <= 0:
        raise ValueError("FPS must be positive")
    return seconds * fps


def make_project_data_serializable(
    original_project_data: Any,
) -> Dict[str, Any]:
    """
    Creates a deep, serializable copy of ProjectData, replacing or removing
    non-serializable DaVinci Resolve objects.
    """
    serializable_data = copy.deepcopy(original_project_data)  # Start with a deep copy

    # Process Timeline field
    if "timeline" in serializable_data:
        for track_type_key in ["video_track_items", "audio_track_items"]:
            if track_type_key in serializable_data["timeline"]:
                for i, item in enumerate(serializable_data["timeline"][track_type_key]):
                    if "bmd_item" in item:
                        # Replace with something identifiable or just remove
                        # For OTIO, often the source_file_path and frame info are more important
                        item["bmd_item_placeholder"] = (
                            f"ResolveTimelineItem_Track{item.get('track_index', 'N/A')}_Index{i}"
                        )
                        del item["bmd_item"]  # Or item["bmd_item"] = None

    # Process Files field
    if "files" in serializable_data:
        for file_path_key, file_data_dict in serializable_data["files"].items():
            # Process FileSource within FileData
            if (
                "fileSource" in file_data_dict
                and "bmd_media_pool_item" in file_data_dict["fileSource"]
            ):
                # Replace with placeholder or path, or just remove
                file_data_dict["fileSource"]["bmd_media_pool_item_placeholder"] = (
                    f"ResolveMediaPoolItem_SourcePath_{file_data_dict['fileSource'].get('file_path', 'N/A')}"
                )
                del file_data_dict["fileSource"]["bmd_media_pool_item"]  # Or = None

            # Process TimelineItems within FileData
            if "timelineItems" in file_data_dict:
                for i, item in enumerate(file_data_dict["timelineItems"]):
                    if "bmd_item" in item:
                        item["bmd_item_placeholder"] = (
                            f"ResolveTimelineItem_InFileData_File_{file_path_key}_Index{i}"
                        )
                        del item["bmd_item"]  # Or item["bmd_item"] = None

    return serializable_data


def is_valid_audio(filepath: str) -> bool:
    """Check if a file exists and has a valid audio stream."""
    if not os.path.exists(filepath):
        return False
    try:
        result: CompletedProcess[str] = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                filepath,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        duration = float(result.stdout.strip())
        return duration > 0.1
    except Exception as e:
        print(f"Error checking audio file {filepath}: {e}")
        return False


def export_to_json(data: Any, output_path: str) -> None:
    def fallback_serializer(obj):
        return "<BMDObject>"

    # make output dir if it doesn't exist
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as json_file:
        json.dump(data, json_file, indent=4, default=fallback_serializer)


def send_message(message_type, payload=None):
    """Sends a structured message to stdout."""
    message = {"type": message_type, "payload": payload}
    print(json.dumps(message))
    sys.stdout.flush()  # Important to ensure the message is sent immediately


class ClipData(TypedDict):
    source_start_frame: float
    source_end_frame: float  # Inclusive end point/time
    start_frame: float
    end_frame: float


class SilenceInterval(TypedDict):
    start: float  # Inclusive source frame/time
    end: float  # Exclusive source frame/time


class FileProperties(TypedDict):
    FPS: float


class EditInstruction(TypedDict):
    source_start_frame: float  # Precise source start point/time (inclusive)
    source_end_frame: float  # Precise source end point/time (inclusive)
    start_frame: float  # Calculated timeline start frame (inclusive)
    end_frame: float  # Calculated timeline end frame (inclusive)
    enabled: bool


class NestedAudioTimelineItem(TypedDict):
    source_file_path: str
    processed_file_name: Optional[str]
    start_frame: float
    end_frame: float
    source_start_frame: float
    source_end_frame: float
    duration: float
    edit_instructions: list[EditInstruction]
    source_channel: int
    nested_items: Optional[list["NestedAudioTimelineItem"]]


class TimelineItem(TypedDict):
    bmd_item: Any
    bmd_mpi: Any
    name: str
    id: str
    track_type: Literal["video", "audio", "subtitle"]
    track_index: int
    source_file_path: str
    processed_file_name: Optional[str]
    start_frame: float
    end_frame: float
    source_start_frame: float
    source_end_frame: float
    duration: float
    edit_instructions: list[EditInstruction]
    source_channel: Optional[int]
    link_group_id: Optional[int]
    type: Optional[Literal["Compound", "Timeline"]]
    nested_clips: Optional[list[NestedAudioTimelineItem]]


def make_empty_timeline_item() -> TimelineItem:
    return {
        "bmd_item": None,
        "bmd_mpi": None,
        "name": "",
        "id": "",
        "track_type": "video",  # or some default
        "track_index": 0,
        "source_file_path": "",
        "processed_file_name": None,
        "start_frame": 0.0,
        "end_frame": 0.0,
        "source_start_frame": 0.0,
        "source_end_frame": 0.0,
        "duration": 0.0,
        "edit_instructions": [],
        "source_channel": None,
        "link_group_id": None,
        "type": None,
        "nested_clips": [],
    }


class TimelineProperties(TypedDict):
    name: str
    FPS: float
    item_usages: List[TimelineItem]


class EditFrames(TypedDict):
    start_frame: float
    end_frame: float
    source_start_frame: float
    source_end_frame: float
    duration: float


class FileSource(TypedDict):
    bmd_media_pool_item: Any
    file_path: str
    uuid: str


class FileData(TypedDict):
    properties: FileProperties
    processed_audio_path: Optional[str]
    silenceDetections: Optional[List[SilenceInterval]]
    timelineItems: list[TimelineItem]
    fileSource: FileSource


class Timeline(TypedDict):
    name: str
    fps: float
    start_timecode: str
    curr_timecode: str
    video_track_items: List[TimelineItem]
    audio_track_items: List[TimelineItem]


class ProjectData(TypedDict):
    project_name: str
    timeline: Timeline
    files: Dict[str, FileData]


class Track(TypedDict):
    name: str
    type: Literal["video", "audio"]
    index: int
    items: List[Any]


class ItemsByTracks(TypedDict):
    videotrack: List[Track]
    audiotrack: List[Track]


class AudioFromVideo(TypedDict):
    video_bmd_media_pool_item: Any
    video_file_path: str
    audio_file_path: str
    audio_file_uuid: str
    audio_file_name: str
    silence_intervals: List[SilenceInterval]


PROJECT_DATA: Optional[ProjectData] = None

TASKS: dict[str, int] = {
    "prepare": 10,
    "append": 40,
    "verify": 10,
    "link": 40,
}


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
        "nested_items": None,  # Added to satisfy TypedDict
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
                    container_duration=container_duration,
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
    global PROJECT_DATA

    project_data = PROJECT_DATA
    if not project_data or "timeline" not in project_data:
        logging.error("Cannot populate nested clips: PROJECT_DATA is not configured.")
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
    pd_timeline: Timeline,
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
            print(
                f"Processing item '{item.get('name')}' on track {track_index} with link group ID: {link_group_id}"
            )

            if link_group_id is not None:
                # Apply the found link ID to all matching items.
                for corresponding_item in corresponding_items:
                    corresponding_item["link_group_id"] = link_group_id
                max_id = max(max_id, link_group_id)

            playhead_frames += duration_val

    return max_id


def unify_edit_instructions(
    items: Sequence[TimelineItem],
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
    global PROJECT_DATA

    project_data = PROJECT_DATA
    if not project_data or "timeline" not in project_data:
        logging.error("Could not initialize or find project data.")
        raise ValueError("PROJECT_DATA is not properly configured.")

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

    items_by_link_group: Dict[int, List[TimelineItem]] = {}
    for item in all_pd_items:
        link_group_id = item.get("link_group_id")
        if link_group_id is not None:
            items_by_link_group.setdefault(link_group_id, []).append(item)

    next_new_group_id = max_link_group_id + 1
    print(f"Scanning {len(all_pd_items)} items for missing link_group_id")
    print(f"all pd items: {all_pd_items}")
    for item in all_pd_items:
        if item.get("link_group_id") is None and item.get("edit_instructions"):
            print(
                f"Item '{item.get('name', 'Unnamed')}' has no link_group_id. Assigning new ID {next_new_group_id}"
            )
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


class ProgressTracker:
    def __init__(self):
        """
        Initializes the tracker and a background thread pool for sending updates.
        """
        self.task_id = ""
        self._tasks = {}
        self._total_weight = 0.0
        self._task_progress = {}
        self._last_report: float = time()

        # 1. Create a thread pool that will handle our HTTP requests.
        #    max_workers can be tuned, but 2-3 is fine for this kind of task.
        self._executor = ThreadPoolExecutor(
            max_workers=3, thread_name_prefix="ProgressUpdater"
        )

        # 2. Register a function to be called when the program exits to ensure
        #    threads are cleaned up gracefully.
        atexit.register(self.shutdown)

    def shutdown(self):
        """Shuts down the thread pool executor."""
        print("\nShutting down progress updater threads...")
        # wait=True ensures we wait for pending updates to be sent before exiting.
        # Set to False if you want the program to exit immediately.
        self._executor.shutdown(wait=True)
        print("Shutdown complete.")

    def start_new_run(self, weighted_tasks: dict[str, int], task_id: str):
        # This method's logic remains the same.
        print(f"Initializing tracker for Task ID: {task_id}")
        self.task_id = task_id
        original_total = sum(weighted_tasks.values())
        if original_total == 0:
            self._tasks, self._total_weight = {}, 0.0
        else:
            scaling_factor = 100 / original_total
            self._tasks = {
                name: weight * scaling_factor for name, weight in weighted_tasks.items()
            }
            self._total_weight = 100.0
        self._task_progress = {task: 0.0 for task in self._tasks}
        # self._report_progress("Initialized")

    def _report_progress(self, message: str, important: bool = False):
        """
        Submits the send_progress_update function to the thread pool
        to be executed in the background.
        """
        # 3. Instead of calling the function directly, submit it to the executor.
        #    The main thread will not wait for this to complete.
        if self.get_percentage() == 100.0:
            important = True  # Always report completion immediately

        if (time() - self._last_report > 0.125) or important:
            self._executor.submit(
                send_progress_update, self.task_id, self.get_percentage(), message
            )
            self._last_report = time()

    def update_task_progress(
        self, task_name: str, percentage: float, message: str = ""
    ):
        if not self.task_id:
            print("Warning: Tracker not initialized. Call start_new_run() first.")
            return
        if task_name not in self._tasks:
            print(f"Warning: Task '{task_name}' not found.")
            return
        percentage = max(0, min(100, percentage))
        important = percentage == 100.0
        if message and not important:
            important = True

        self._task_progress[task_name] = self._tasks[task_name] * (percentage / 100.0)
        update_message = message if message is not None else task_name
        print(
            f"Updating '{task_name}' to {percentage:.1f}%. Overall: {self.get_percentage():.2f}%"
        )
        self._report_progress(update_message, important=important)

    def complete_task(self, task_name: str):
        self.update_task_progress(task_name, 100.0)

    def get_percentage(self) -> float:
        if self._total_weight == 0:
            return 0.0
        return (sum(self._task_progress.values()) / self._total_weight) * 100

    def __str__(self):
        return (
            f"Task ID '{self.task_id}' | Overall Progress: {self.get_percentage():.2f}%"
        )


TRACKER = ProgressTracker()


def send_message_to_go(message_type: str, payload: Any, task_id: Optional[str] = None):
    global GO_SERVER_PORT
    if GO_SERVER_PORT == 0:
        print("Python Error: Go server port not configured. Cannot send message to Go.")
        return False

    # Use http.client for sending messages to Go
    conn = None
    try:
        conn = HTTPConnection("localhost", GO_SERVER_PORT, timeout=5)
        headers = {"Content-Type": "application/json"}

        # Helper to serialize objects that might not be directly JSON serializable
        def fallback_serializer(obj):
            if hasattr(obj, "__dict__"):
                return obj.__dict__
            return str(obj)  # Fallback to string representation

        # Construct the message as expected by the Go backend
        go_message = {"Type": message_type, "Payload": payload}
        json_payload = json.dumps(go_message, default=fallback_serializer)

        path = f"/msg?task_id={task_id}" if task_id else "/msg"
        conn.request("POST", path, body=json_payload, headers=headers)
        response = conn.getresponse()

        if response.status >= 200 and response.status < 300:
            print(
                f"Python (to Go): Message type '{message_type}' sent. Task id: {task_id}. Go responded: {response.status}"
            )
            return True
        else:
            print(
                f"Python (to Go): Error sending message type '{message_type}'. Go responded with status {response.status}: {response.read().decode()}"
            )
            return False
    except Exception as e:
        print(f"Python (to Go): HTTP error sending message type '{message_type}': {e}")
        return False
    finally:
        if conn:
            conn.close()


def resolve_import_error_msg(e: Exception, task_id: str = "") -> None:
    print(f"Failed to import GetResolve: {e}")
    print("Check and ensure DaVinci Resolve installation is correct.")

    send_message_to_go(
        "showAlert",
        {
            "title": "DaVinci Resolve Error",
            "message": "Failed to import DaVinci Resolve Python API.",
            "severity": "error",
        },
        task_id=task_id,
    )
    return None


def get_resolve(task_id: str = "") -> None:
    global RESOLVE
    resolve_modules_path: str = ""
    if sys.platform.startswith("darwin"):
        resolve_modules_path = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/"
    elif sys.platform.startswith("win") or sys.platform.startswith("cygwin"):
        resolve_modules_path = os.path.join(
            str(os.getenv("PROGRAMDATA"))
            if os.getenv("PROGRAMDATA") is not None
            else "",
            "Blackmagic Design",
            "DaVinci Resolve",
            "Support",
            "Developer",
            "Scripting",
            "Modules",
        )
    elif sys.platform.startswith("linux"):
        resolve_modules_path = "/opt/resolve/Developer/Scripting/Modules/"

    if resolve_modules_path and resolve_modules_path not in sys.path:
        sys.path.insert(0, resolve_modules_path)
        print(f"Added to sys.path: {resolve_modules_path}")
    else:
        print(f"Already in sys.path: {resolve_modules_path}")

    try:
        # Attempt to import after modifying sys.path
        import DaVinciResolveScript as bmd  # type: ignore
    except ImportError as e:
        resolve_import_error_msg(e, task_id)
        return None
    except Exception as e:
        resolve_import_error_msg(e, task_id)
        return None
    print("was able to import DaVinciResolveScript")

    resolve_obj = bmd.scriptapp("Resolve")
    if not resolve_obj:
        try:
            resolve_obj = resolve  # type: ignore  # noqa: F821
        except Exception as e:
            print(f"could not get resolve_obj by calling resolve var directly. {e}")
            resolve_import_error_msg(
                e=Exception("Failed to import DaVinci Resolve Python API.", task_id)
            )
            return None

    RESOLVE = resolve_obj


def export_timeline_to_otio(timeline: Any, file_path: str) -> None:
    """
    Export the current timeline to an XML file.

    Args:
        timeline (Any): The timeline object to export.
        file_path (str): The path where the XML file will be saved.
    """
    global RESOLVE

    if not RESOLVE:
        return

    if not timeline:
        print("No timeline to export.")
        return

    success = timeline.Export(file_path, RESOLVE.EXPORT_OTIO)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


ResolvePage = Literal["edit", "color", "fairlight", "fusion", "deliver"]


def switch_to_page(page: ResolvePage) -> None:
    global RESOLVE
    if not RESOLVE:
        return

    current_page = RESOLVE.GetCurrentPage()
    if current_page != page:
        RESOLVE.OpenPage(page)
        print(f"Switched to {page} page.")
    else:
        print(f"Already on {page} page.")


def get_items_by_tracktype(
    track_type: Literal["video", "audio"], timeline: Any
) -> list[TimelineItem]:
    items: list[TimelineItem] = []
    track_count = timeline.GetTrackCount(track_type)
    for i in range(1, track_count + 1):
        track_items = timeline.GetItemListInTrack(track_type, i) or []
        for item_bmd in track_items:
            start_frame = item_bmd.GetStart(True)
            item_name = item_bmd.GetName()
            media_pool_item = item_bmd.GetMediaPoolItem()
            left_offset = item_bmd.GetLeftOffset(True)
            duration = item_bmd.GetDuration(True)
            source_start_float = left_offset
            source_end_float = left_offset + duration

            source_file_path: str = (
                media_pool_item.GetClipProperty("File Path") if media_pool_item else ""
            )
            timeline_item: TimelineItem = {
                "bmd_item": item_bmd,
                "bmd_mpi": media_pool_item,
                "duration": duration,
                "name": item_name,
                "edit_instructions": [],
                "start_frame": start_frame,
                "end_frame": item_bmd.GetEnd(True),
                "id": get_item_id(item_bmd, item_name, start_frame, track_type, i),
                "track_type": track_type,
                "track_index": i,
                "source_file_path": source_file_path,
                "processed_file_name": None,  # Initialized as None
                "source_start_frame": source_start_float,
                "source_end_frame": source_end_float,
                "source_channel": 0,  # Default value
                "link_group_id": None,  # Default value
                "type": None,  # Default value, changed from "Clip"
                "nested_clips": [],  # Default value
            }
            if media_pool_item and not source_file_path:
                # This branch means it's likely a compound clip, generator, or title.
                # Capture its type, and initialize nested_clips for later OTIO population.
                clip_type = media_pool_item.GetClipProperty("Type")
                print(f"Detected clip type: {clip_type} for item: {item_name}")
                timeline_item["type"] = clip_type
                timeline_item["nested_clips"] = []  # Initialize as empty list

            items.append(timeline_item)

    return items


def _verify_timeline_state(
    timeline: Any, expected_clips: List[Dict], attempt_num: int
) -> bool:
    """
    Verifies that the clips on the timeline match the expected state.

    Args:
        timeline: The DaVinci Resolve timeline object.
        expected_clips: A list of clip info dictionaries that were intended to be appended.

    Returns:
        True if the timeline state is correct, False otherwise.
    """
    print("Verifying timeline state...")
    TRACKER.update_task_progress("verify", 1.0, message="Verifying")
    # 1. Build the "checklist" of expected cuts.
    # We use a Counter to handle multiple clips starting at the same frame on the same track.
    expected_cuts = Counter()
    for clip in expected_clips:
        key = (clip["mediaType"], clip["trackIndex"], int(clip["recordFrame"]))
        expected_cuts[key] += 1

    # 2. Get the actual clips from the timeline.
    actual_video_items = get_items_by_tracktype("video", timeline)
    actual_audio_items = get_items_by_tracktype("audio", timeline)

    # 3. "Check off" items from our checklist.
    for item in actual_video_items + actual_audio_items:
        media_type = 1 if item["track_type"] == "video" else 2
        key = (media_type, item["track_index"], int(item["start_frame"]))
        if key in expected_cuts:
            expected_cuts[key] -= 1  # Decrement the count for this cut
        else:
            print(
                f"  - Found an unexpected clip: {item['track_type']} track {item['track_index']} at frame {item['start_frame']}"
            )
            # Finding an unexpected clip is not a failure for this logic,
            # as it might be from a previous, unrelated operation.
            # The failure is determined by NOT finding an expected clip.

    # 4. Check if any expected cuts are "left over".
    # We use `+expected_cuts` to filter out zero and negative counts.
    missing_cuts = +expected_cuts

    if not missing_cuts:
        print("  - Verification successful. All expected clips were found.")
        return True
    else:
        print("  - Verification FAILED. The following clips are missing:")
        for (media_type, track_index, start_frame), count in missing_cuts.items():
            track_type = "video" if media_type == 1 else "audio"
            print(
                f"    - Missing {count} clip(s) on {track_type} track {track_index} at frame {start_frame}"
            )
        return False


def generate_uuid_from_nested_clips(
    top_level_item: TimelineItem, nested_clips: list[NestedAudioTimelineItem]
) -> str:
    """
    Generates a deterministic, content-based UUID for a compound or multicam clip.

    The UUID is derived from the top-level item's properties and a sorted,
    canonical representation of all its nested audio clips. Any change to the
    nested content (e.g., trimming a clip, changing a multicam angle) will
    result in a new UUID.

    Args:
        top_level_item: The timeline item for the compound/multicam clip.
        nested_clips: The list of resolved nested audio clips.

    Returns:
        A unique and stable UUID string based on the clip's content.
    """
    # 1. Start with the top-level clip's unique properties.
    # The BMD Unique ID ensures we're starting from the correct source media pool item.
    bmd_item = top_level_item.get("bmd_mpi")
    seed_string = (
        f"bmd_id:{bmd_item.GetUniqueId()};" if bmd_item else "bmd_id:<unknown>;"
    )
    seed_string += (
        f"duration:{top_level_item['end_frame'] - top_level_item['start_frame']};"
    )
    seed_string += f"source_start:{top_level_item['source_start_frame']};"
    seed_string += f"source_end:{top_level_item['source_end_frame']};"

    # 2. Add properties from all nested clips.
    # We must sort the clips to ensure the order is always the same,
    # otherwise the same content could produce different UUIDs.
    # We sort by the clip's start time within the container.
    sorted_nested_clips = sorted(nested_clips, key=lambda x: x["start_frame"])

    nested_strings = []
    for clip in sorted_nested_clips:
        # Create a unique signature for each nested clip
        clip_signature = (
            f"path:{clip['source_file_path']},"
            f"start:{clip['start_frame']},"
            f"end:{clip['end_frame']},"
            f"s_start:{clip['source_start_frame']},"
            f"s_end:{clip['source_end_frame']}"
        )
        nested_strings.append(clip_signature)

    # Combine all nested signatures into the main seed string
    seed_string += "nested_clips[" + "||".join(nested_strings) + "]"

    # 3. Generate a UUIDv5 hash from the canonical seed string.
    # UUIDv5 is perfect for this as it's designed to create a deterministic
    # UUID from a name within a namespace.
    content_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, seed_string)

    return str(content_uuid)


def mixdown_compound_clips(
    audio_timeline_items: list[TimelineItem],
    curr_processed_file_names: list[str],
):
    """
    Finds unique compound/multicam content on the timeline, and for each,
    either renders a mixdown (standalone mode) or prepares the data for Go.
    """
    global TEMP_DIR

    # --- Pass 1: Map all compound/multicam clips by their content UUID ---
    content_map = {}
    for item in audio_timeline_items:
        if not item.get("type") or not item.get("nested_clips"):
            continue

        nested_clips_list = item["nested_clips"]
        if nested_clips_list is None:
            continue

        content_uuid = generate_uuid_from_nested_clips(item, nested_clips_list)
        if content_uuid not in content_map:
            content_map[content_uuid] = []
        content_map[content_uuid].append(item)

    # --- Pass 2: Process each unique content group ---
    for content_uuid, items_in_group in content_map.items():
        representative_item = items_in_group[0]
        output_filename = f"{content_uuid}.wav"
        output_wav_path = os.path.join(TEMP_DIR, output_filename)

        needs_render = f"{content_uuid}.wav" not in curr_processed_file_names

        if needs_render:
            print(
                f"Go Mode: Skipping local render for new content ID {content_uuid}. Go will handle it."
            )
        else:
            print(
                f"Content for '{representative_item['name']}' is unchanged. Skipping render."
            )

        # This block runs for all items in Go mode, or only for successful renders in Standalone mode.
        for tl_item in items_in_group:
            tl_item["processed_file_name"] = output_filename
            tl_item["source_file_path"] = output_wav_path
            tl_item["source_start_frame"] = 0.0
            tl_item["source_end_frame"] = tl_item["end_frame"] - tl_item["start_frame"]


def get_project_data(project, timeline) -> Tuple[bool, str | None]:
    global PROJECT, MEDIA_POOL, TEMP_DIR, PROJECT_DATA

    # --- 1. Initial Data Gathering ---
    timeline_name = timeline.GetName()
    timeline_fps = timeline.GetSetting("timelineFrameRate")
    video_track_items: list[TimelineItem] = get_items_by_tracktype("video", timeline)
    audio_track_items: list[TimelineItem] = get_items_by_tracktype("audio", timeline)

    tl_dict: Timeline = {
        "name": timeline_name,
        "fps": timeline_fps,
        "start_timecode": timeline.GetStartTimecode(),
        "curr_timecode": timeline.GetCurrentTimecode(),
        "video_track_items": video_track_items,
        "audio_track_items": audio_track_items,
    }
    PROJECT_DATA = {
        "project_name": project.GetName(),
        "timeline": tl_dict,
        "files": {},
    }

    if any(item.get("type") for item in audio_track_items):
        print("Complex clips found. Analyzing timeline structure with OTIO...")
        input_otio_path = os.path.join(TEMP_DIR, "temp-timeline.otio")
        export_timeline_to_otio(timeline, file_path=input_otio_path)
        populate_nested_clips(
            input_otio_path
        )  # This populates the 'nested_clips' array

    # --- 2. Analyze Mappings & Define Streams (Runs for BOTH modes) ---
    print("Analyzing timeline items and audio channel mappings...")
    for item in audio_track_items:
        if not item.get("source_file_path"):
            continue

        source_path = item["source_file_path"]
        source_uuid = uuid_from_path(source_path).hex

        item["source_channel"] = 0  # Default to 0 (mono mixdown)
        item["processed_file_name"] = f"{source_uuid}.wav"

        try:
            mapping_str = item["bmd_item"].GetSourceAudioChannelMapping()
            if mapping_str:
                mapping = json.loads(mapping_str)
                clip_track_map = mapping.get("track_mapping", {}).get("1", {})
                clip_type = clip_track_map.get("type")
                channel_indices = clip_track_map.get("channel_idx", [])

                # --- THIS IS THE FIX for the source_channel bug ---
                # Check for clip_type and convert to lower for case-insensitive comparison.
                if (
                    clip_type
                    and clip_type.lower() == "mono"
                    and len(channel_indices) == 1
                ):
                    channel_num = channel_indices[0]
                    print(
                        f"Detected clip '{item['name']}' using specific source channel: {channel_num}"
                    )
                    item["source_channel"] = channel_num
                    item["processed_file_name"] = f"{source_uuid}_ch{channel_num}.wav"
        except Exception as e:
            print(
                f"Warning: Could not get audio mapping for '{item['name']}'. Defaulting to mono mixdown. Error: {e}"
            )

    # --- 3. [NEW] Populate the 'files' map for data consistency ---
    # This ensures the Go backend and frontend have a complete data model, even if it's partly redundant.
    for item in audio_track_items:
        source_path = item.get("source_file_path")
        if not source_path:
            continue

        # If the file is not yet in our map, add it.
        if source_path not in PROJECT_DATA["files"]:
            PROJECT_DATA["files"][source_path] = {
                "properties": {"FPS": timeline_fps},
                "processed_audio_path": None,  # Added to satisfy TypedDict
                "timelineItems": [],
                "fileSource": {
                    "file_path": source_path,
                    "uuid": uuid_from_path(source_path).hex,
                    "bmd_media_pool_item": item["bmd_mpi"],
                },
                "silenceDetections": None,
                # Note: 'processed_audio_path' is no longer relevant in this map,
                # as all processing is now per-timeline-item.
            }

    # --- 4. Handle Compound Clips ---
    if any(item.get("type") for item in audio_track_items):
        print("Complex clips found...")
        mixdown_compound_clips(audio_track_items, [])

    return True, None


def apply_edits_from_go(
    target_project: ProjectData, source_project: ProjectData
) -> ProjectData:
    """
    Applies ONLY the 'edit_instructions' from a source project data structure
    to the target, matching audio timeline items by their unique ID.

    This function is intentionally simple to robustly update the target with
    the essential data from the frontend without side effects.
    """
    print("Applying edit instructions from Go...")
    # pprint.pprint(source_project)

    # Create an efficient lookup map of the audio items sent from Go.
    source_audio_items = source_project.get("timeline", {}).get("audio_track_items", [])
    source_items_by_id = {
        item["id"]: item for item in source_audio_items if "id" in item
    }

    if not source_items_by_id:
        print(
            "Warning: No audio items with IDs found in data from Go. No edits applied."
        )
        return source_project

    # Get the target audio items that we will modify in-place.
    target_audio_items = target_project.get("timeline", {}).get("audio_track_items", [])

    items_updated_count = 0
    # Iterate through the target items and apply the source's edit instructions.
    for target_item in target_audio_items:
        item_id = target_item.get("id")

        # Find the matching item from the source data.
        if item_id and item_id in source_items_by_id:
            source_item = source_items_by_id[item_id]

            # This is the core logic: copy the edit_instructions if they exist.
            if "edit_instructions" in source_item:
                target_item["edit_instructions"] = source_item["edit_instructions"]
                items_updated_count += 1

    print(f"Finished applying edits. Updated {items_updated_count} timeline items.")
    return target_project


def send_result_with_alert(
    alert_title: str,
    alert_message: str,
    task_id: str,
    alert_severity: str = "error",
):
    response_payload = {
        "status": "error",
        "message": alert_message,
        "shouldShowAlert": True,
        "alertTitle": alert_title,
        "alertMessage": alert_message,
        "alertSeverity": alert_severity,
    }

    send_message_to_go(
        "taskResult",
        response_payload,
        task_id=task_id,
    )


def send_progress_update(
    task_id: str,
    progress: float,
    message: str = "error",
):
    response_payload = {"message": message, "progress": progress}

    send_message_to_go(
        "taskUpdate",
        response_payload,
        task_id=task_id,
    )


def set_timecode(timecode: str, task_id: str = "") -> bool:
    global RESOLVE
    global PROJECT
    global TIMELINE
    if not timecode:
        return False

    if not RESOLVE:
        return False
    if not TIMELINE:
        return False

    if not TIMELINE.SetCurrentTimecode(timecode):
        return False

    return True


def main(sync: bool = False, task_id: str = "") -> Optional[bool]:
    global RESOLVE
    global TEMP_DIR
    global PROJECT
    global TIMELINE
    global MEDIA_POOL
    global TRACKER
    global TASKS
    global PROJECT_DATA

    script_start_time: float = time()
    print("running main function...")

    if not sync:
        TRACKER.start_new_run(TASKS, task_id)
        TRACKER.update_task_progress("prepare", 0.1, message="Preparing")

    if not RESOLVE:
        task_id = task_id or ""
        get_resolve(task_id)
    if not RESOLVE:
        print("could not get resolve object")
        PROJECT_DATA = None
        alert_title = "DaVinci Resolve Error"
        message = "Could not connect to DaVinci Resolve. Is it running?"
        send_result_with_alert(alert_title, message, task_id)
        return False

    if not RESOLVE.GetProjectManager():
        print("no project")
        PROJECT = None
        alert_title = "DaVinci Resolve Error"
        message = "Could not connect to DaVinci Resolve. Is it running?"
        send_result_with_alert(alert_title, message, task_id)

    PROJECT = RESOLVE.GetProjectManager().GetCurrentProject()

    if not PROJECT:
        PROJECT_DATA = None
        MEDIA_POOL = None
        alert_title = "No open project"
        message = "Please open a project and a timeline."

        response_payload = {
            "status": "error",
            "message": message,
            "shouldShowAlert": True,
            "alertTitle": alert_title,
            "alertMessage": message,
            "alertSeverity": "error",
        }
        send_message_to_go(
            "taskResult",
            response_payload,
            task_id=task_id,
        )
        return False

    TIMELINE = PROJECT.GetCurrentTimeline()
    if not TIMELINE:
        PROJECT_DATA = None
        message = "Please open a timeline."

        response_payload = {
            "status": "error",
            "message": message,
            "data": PROJECT_DATA,
            "shouldShowAlert": True,
            "alertTitle": "No Open Timeline",
            "alertMessage": message,  # Specific message for the alert
            "alertSeverity": "error",
        }

        send_message_to_go("taskResult", response_payload, task_id=task_id)
        return False

    # export state of current timeline to otio, EXPENSIVE
    input_otio_path = os.path.join(TEMP_DIR, "temp-timeline.otio")

    if sync or not PROJECT_DATA:
        success, alert_title = get_project_data(PROJECT, TIMELINE)
        if not alert_title:
            alert_title = "Sync error"
        if not success:
            response_payload = {
                "status": "error",
                "message": alert_title,
                "shouldShowAlert": True,
                "alertTitle": alert_title,
                "alertMessage": "",  # Specific message for the alert
                "alertSeverity": "error",
            }
            print(response_payload)
            send_message_to_go("taskResult", response_payload, task_id=task_id)
            return

    if sync:
        output_dir = os.path.join(TEMP_DIR, "debug_project_data.json")
        print(f"exporting debug json to {output_dir}")
        export_to_json(PROJECT_DATA, output_dir)

        print("just syncing, exiting")
        print(f"it took {time() - script_start_time:.2f} seconds for script to finish")

        response_payload = {
            "status": "success",
            "message": "Sync successful!",
            "data": PROJECT_DATA,
        }

        send_message_to_go(
            message_type="taskResult", payload=response_payload, task_id=task_id
        )
        export_timeline_to_otio(TIMELINE, file_path=input_otio_path)
        print(f"Exported timeline to OTIO in {input_otio_path}")
        return

    if not PROJECT_DATA:
        alert_message = "An unexpected error happened during sync. Could not get project data from DaVinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return

    # safety check: do we have bmd items?
    all_timeline_items = (
        PROJECT_DATA["timeline"]["video_track_items"]
        + PROJECT_DATA["timeline"]["audio_track_items"]
    )

    if not all_timeline_items:
        print("critical error, can't continue")
        alert_message = "An unexpected error happened during sync. Could not get timeline items from DaVinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return

    some_bmd_item = all_timeline_items[0]["bmd_item"]
    if not some_bmd_item or isinstance(some_bmd_item, str):
        print("critical error, can't continue")
        alert_message = "An unexpected error happened during sync. Could not get timeline items from DaVinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)

    TRACKER.update_task_progress("prepare", 50.0, message="Preparing")
    unify_linked_items_in_project_data(input_otio_path)
    print(f"project data after unify: {PROJECT_DATA}")

    TRACKER.complete_task("prepare")
    TRACKER.update_task_progress("append", 1.0, "Adding Clips to Timeline")

    append_and_link_timeline_items(MAKE_NEW_TIMELINE, task_id)

    TRACKER.complete_task("append")

    execution_time = time() - script_start_time
    # TODO: send this to the frontend, alongside other statistics like cuts made, total silence duration or silences removed (seconds)
    print(f"it took {round(execution_time, 2)}s to complete")

    response_payload = {
        "status": "success",
        "message": "Edit successful!",
    }

    send_message_to_go(
        message_type="taskResult", payload=response_payload, task_id=task_id
    )

    # apply_edits()


def get_item_id(
    item: Any, item_name: str, start_frame: float, track_type: str, track_index: int
) -> str:
    return f"{item_name}-{track_type}-{track_index}--{start_frame}"


class ClipInfo(TypedDict):
    mediaPoolItem: Any
    startFrame: float
    endFrame: float
    recordFrame: float
    mediaType: Optional[int]  # 1 for video only, 2 for audio only
    trackIndex: int


class AppendedClipInfo(TypedDict):
    clip_info: Dict
    link_key: Tuple[int, int]
    enabled: bool
    auto_linked: bool  # Flag to track optimization


def _append_clips_to_timeline(
    timeline: Any, media_pool: Any, timeline_items: List[TimelineItem]
) -> Tuple[List[AppendedClipInfo], List[Any]]:
    """
    Groups clips, prepares a SINGLE batch of instructions for the API with a
    mix of optimized (auto-linked) and standard clips, then makes one API call.
    """
    grouped_clips: Dict[Tuple[int, int], List[AppendedClipInfo]] = {}

    # This initial grouping logic remains the same
    for item in timeline_items:
        link_id = item.get("link_group_id")
        if link_id is None:
            continue
        media_type = 1 if item["track_type"] == "video" else 2
        for i, edit in enumerate(item.get("edit_instructions", [])):
            record_frame = round(edit.get("start_frame", 0))
            end_frame = round(edit.get("end_frame", 0))
            duration_frames = end_frame - record_frame
            if duration_frames < 1:
                continue
            source_start = edit.get("source_start_frame", 0)
            source_end = source_start + duration_frames

            if not item.get("bmd_mpi"):
                item["bmd_mpi"] = item["bmd_item"].GetMediaPoolItem()

            clip_info_for_api: Dict = {
                "mediaPoolItem": item["bmd_mpi"],
                "startFrame": source_start,
                "endFrame": source_end,
                "recordFrame": record_frame,
                "trackIndex": item["track_index"],
                "mediaType": media_type,
            }
            link_key = (link_id, i)
            appended_clip: AppendedClipInfo = {
                "clip_info": clip_info_for_api,
                "link_key": link_key,
                "enabled": edit.get("enabled", True),
                "auto_linked": False,
            }
            grouped_clips.setdefault(link_key, []).append(appended_clip)

    if not grouped_clips:
        return [], []

    # --- REFACTORED LOGIC: Build a single API batch ---
    final_api_batch: List[Dict] = []
    all_processed_clips: List[AppendedClipInfo] = []

    for link_key, group in grouped_clips.items():
        is_optimizable = False
        if len(group) == 2:
            clip1, clip2 = group
            mpi1 = clip1["clip_info"]["mediaPoolItem"]
            mpi2 = clip2["clip_info"]["mediaPoolItem"]
            path1 = mpi1.GetClipProperty("File Path") if mpi1 else None
            path2 = mpi2.GetClipProperty("File Path") if mpi2 else None

            if (
                {c["clip_info"]["mediaType"] for c in group} == {1, 2}
                and clip1["clip_info"]["trackIndex"] == 1
                and clip2["clip_info"]["trackIndex"] == 1
                and (path1 is not None and path1 == path2)
            ):
                is_optimizable = True

        if is_optimizable:
            print(f"Optimizing append for link group {link_key} on Track 1.")
            # Mark both original clips as auto-linked for the next step
            for clip in group:
                clip["auto_linked"] = True

            # Prepare a single, optimized instruction for the API call
            optimized_clip_info = group[0]["clip_info"].copy()
            del optimized_clip_info["mediaType"]
            del optimized_clip_info["trackIndex"]
            final_api_batch.append(optimized_clip_info)
        else:
            # If not optimizable, add the original clip_info for each clip
            for clip in group:
                final_api_batch.append(clip["clip_info"])

        # Always add the full, original clip info to our source-of-truth list
        all_processed_clips.extend(group)

    all_processed_clips.sort(key=lambda item: item["clip_info"].get("recordFrame", 0))

    # --- Make unified API calls with a defined batch size ---
    print(f"Appending {len(final_api_batch)} total clip instructions to timeline...")
    BATCH_SIZE = 100
    appended_bmd_items: List[Any] = []

    for i in range(0, len(final_api_batch), BATCH_SIZE):
        chunk = final_api_batch[i : i + BATCH_SIZE]
        appended = media_pool.AppendToTimeline(chunk) or []
        appended_bmd_items.extend(appended)
        if appended:
            TRACKER.update_task_progress(
                "append",
                10.0 + (i / len(final_api_batch)) * 80.0,
            )

    return all_processed_clips, appended_bmd_items


def clip_is_uncut(item: TimelineItem) -> bool:
    """
    Checks if a clip is uncut, meaning it has no edit instructions.
    """
    if not item.get("edit_instructions") or len(item["edit_instructions"]) == 0:
        return True

    if len(item["edit_instructions"]) > 1:
        return False

    # check if the only edit instruction is a full clip
    edit_instruction = item["edit_instructions"][0]
    if (
        edit_instruction["start_frame"] == item["start_frame"]
        and edit_instruction["end_frame"] == item["end_frame"]
        and edit_instruction["source_start_frame"] == item["source_start_frame"]
        and edit_instruction["source_end_frame"] == item["source_end_frame"]
    ):
        return True

    return False


def append_and_link_timeline_items(
    create_new_timeline: bool = True, task_id=""
) -> None:
    """
    Appends clips to the timeline, using an optimized auto-linking method where
    possible, and then manually links any remaining clips.
    """
    global MEDIA_POOL, TIMELINE, PROJECT, PROJECT_DATA

    if not PROJECT_DATA or not PROJECT_DATA.get("timeline"):
        print("Error: Project data is missing or malformed.")
        return

    project_data = PROJECT_DATA

    if not PROJECT:
        print("Error: Could not get current project.")
        return

    MEDIA_POOL = PROJECT.GetMediaPool()
    media_pool = MEDIA_POOL
    if not media_pool:
        print("Error: MediaPool object not available.")
        return

    timeline_items = project_data["timeline"].get(
        "video_track_items", []
    ) + project_data["timeline"].get("audio_track_items", [])

    max_indices = {"video": 0, "audio": 0}
    for item in timeline_items:
        track_type = item.get("track_type")
        track_index = item.get("track_index", 1)
        if track_type in max_indices:
            max_indices[track_type] = max(max_indices[track_type], track_index)
    og_tl_name = project_data["timeline"]["name"]

    timeline = None
    if create_new_timeline:
        print("Creating a new timeline...")

        if og_tl_name not in created_timelines:
            created_timelines[og_tl_name] = 1

        retries = 0
        while retries < MAX_RETRIES:
            index = created_timelines[og_tl_name]
            timeline_name = f"{og_tl_name}-hc-{index:02d}"
            timeline = media_pool.CreateEmptyTimeline(timeline_name)

            if timeline:
                timeline.SetStartTimecode(project_data["timeline"]["start_timecode"])
                created_timelines[og_tl_name] += 1
                break
            else:
                created_timelines[og_tl_name] += 1
                retries += 1

        if not timeline:
            send_result_with_alert(
                task_id=task_id,
                alert_message=f"Could not create new timeline after {MAX_RETRIES} attempts.",
                alert_title="DaVinci Error",
            )
            return
    else:
        timeline = TIMELINE
        if timeline:
            # --- FIX: Robustly clear all tracks on the existing timeline ---
            print("Clearing all clips from existing timeline...")
            all_clips_to_delete = []

            # Iterate through all video tracks that might have content
            for item in PROJECT_DATA["timeline"]["video_track_items"]:
                type = item["type"]
                if type:
                    all_clips_to_delete.extend(item["bmd_item"])
                if not item["bmd_mpi"]:
                    item["bmd_mpi"] = item["bmd_item"].GetMediaPoolItem()
                if not item["bmd_mpi"]:
                    print(
                        f"Warning: No MediaPoolItem found for item '{item['name']}'. Skipping."
                    )
                    continue
                # don't delete items with no edit instructions, or empty edit instructions
                if not item.get("edit_instructions"):
                    print(f"Skipping item '{item['name']}' with no edit instructions.")
                    continue

                if clip_is_uncut(item):
                    print(f"Skipping uncut item '{item['name']}' with no edits.")
                    continue

                all_clips_to_delete.append(item["bmd_item"])

            for item in PROJECT_DATA["timeline"]["audio_track_items"]:
                type = item["type"]
                if type:
                    all_clips_to_delete.extend(item["bmd_item"])
                if not item["bmd_mpi"]:
                    continue

                if not item.get("edit_instructions"):
                    print(f"Skipping item '{item['name']}' with no edit instructions.")
                    continue

                if clip_is_uncut(item):
                    print(f"Skipping uncut item '{item['name']}' with no edits.")
                    continue

                all_clips_to_delete.append(item["bmd_item"])

            if all_clips_to_delete:
                print(f"Deleting {len(all_clips_to_delete)} existing clips...")
                timeline.DeleteClips(all_clips_to_delete)
            else:
                print("Timeline is already empty.")

    if not timeline:
        print("Error: Could not get a valid timeline. Aborting operation.")
        return

    for track_type, required_count in max_indices.items():
        current_count = timeline.GetTrackCount(track_type)
        tracks_to_add = required_count - current_count
        if tracks_to_add > 0:
            print(
                f"Timeline has {current_count} {track_type} tracks, adding {tracks_to_add} more..."
            )
            for _ in range(tracks_to_add):
                timeline.AddTrack(track_type)

    print(f"Operating on timeline: '{timeline.GetName()}'")
    TIMELINE = timeline

    TRACKER.update_task_progress("append", 10.0, "Adding Clips to Timeline")
    # === STEP 4: APPEND, VERIFY, AND LINK CLIPS ===
    success = False
    num_retries = 4
    sleep_time_between = 2.5
    for attempt in range(1, num_retries + 1):
        processed_clips, bmd_items_from_api = _append_clips_to_timeline(
            TIMELINE, media_pool, timeline_items
        )
        TRACKER.complete_task("append")
        if not processed_clips:
            success = True
            break

        expected_clip_infos = [item["clip_info"] for item in processed_clips]

        if _verify_timeline_state(TIMELINE, expected_clip_infos, attempt):
            TRACKER.complete_task("verify")
            print("Verification successful. Proceeding to modify and link.")

            auto_linked_keys: set[Tuple[int, int]] = {
                clip["link_key"] for clip in processed_clips if clip.get("auto_linked")
            }
            if auto_linked_keys:
                print(
                    f"Identified {len(auto_linked_keys)} auto-linked groups to skip for manual linking."
                )

            link_key_lookup: Dict[Tuple[Optional[int], int, int], Tuple[int, int]] = {}
            for appended_clip in processed_clips:
                clip_info, link_key = (
                    appended_clip["clip_info"],
                    appended_clip["link_key"],
                )
                lookup_key = (
                    clip_info.get("mediaType"),
                    clip_info["trackIndex"],
                    int(clip_info["recordFrame"]),  # Cast to int
                )
                link_key_lookup[lookup_key] = link_key

            actual_items: list[TimelineItem] = []
            actual_items.extend(get_items_by_tracktype("video", TIMELINE))
            actual_items.extend(get_items_by_tracktype("audio", TIMELINE))

            disabled_keys = {
                (
                    p_clip["clip_info"]["mediaType"],
                    p_clip["clip_info"]["trackIndex"],
                    p_clip["clip_info"]["recordFrame"],
                )
                for p_clip in processed_clips
                if not p_clip["enabled"]
            }
            if disabled_keys:
                disabled_count = 0
                for item_dict in actual_items:
                    media_type = 1 if item_dict["track_type"] == "video" else 2
                    actual_key = (
                        media_type,
                        item_dict["track_index"],
                        item_dict["start_frame"],
                    )
                    if actual_key in disabled_keys:
                        bmd_item = item_dict["bmd_item"]
                        bmd_item.SetClipColor("Violet")
                        disabled_count += 1
                print(f"Updated status for {disabled_count} clip(s).")

            link_groups: Dict[Tuple[int, int], List[Any]] = {}
            for item_dict in actual_items:
                media_type = 1 if item_dict["track_type"] == "video" else 2
                # Note: For auto-linked clips, multiple actual items might map back
                # via different mediaTypes to the same original recordFrame.
                # The lookup key must be specific.
                lookup_key = (
                    media_type,
                    item_dict["track_index"],
                    int(item_dict["start_frame"]),
                )
                link_key = link_key_lookup.get(lookup_key)
                if link_key:
                    link_groups.setdefault(link_key, []).append(item_dict["bmd_item"])

            print("Performing manual linking for necessary clips...")
            groups_to_link = {
                k: v for k, v in link_groups.items() if k not in auto_linked_keys
            }

            if not groups_to_link:
                print("No clips required manual linking.")
            else:
                length_link_groups = len(groups_to_link)
                index = 1
                for group_key, clips_to_link in groups_to_link.items():
                    if len(clips_to_link) >= 2:
                        print(f"  - Manually linking group: {group_key}")
                        TIMELINE.SetClipsLinked(clips_to_link, True)

                    if index % 10 == 1:
                        percentage = (index / length_link_groups) * 100
                        TRACKER.update_task_progress(
                            "link", percentage, "Linking clips..."
                        )
                    index += 1

            TRACKER.complete_task("link")
            print("✅ Operation completed successfully.")
            success = True
            break
        else:
            print(f"Attempt {attempt} failed. Rolling back changes...")
            if bmd_items_from_api:
                TIMELINE.DeleteClips(bmd_items_from_api, delete_gaps=False)
            if attempt < num_retries:
                sleep(sleep_time_between)
                sleep_time_between += 1.5

    if not success:
        print("❌ Operation failed after all retries. Please check the logs.")


# Add this new global event
go_server_ready_event = threading.Event()


def wait_for_go_ready(go_server_port: int) -> bool:
    """
    Waits for the Go server to signal its readiness by successfully connecting to its /ready endpoint.
    """
    print("Python Backend: Waiting for Go server to register...")
    # Wait for the event to be set by the /register endpoint
    event_was_set = go_server_ready_event.wait(timeout=25)  # 25 second timeout
    if not event_was_set:
        print("Python Backend: Timed out waiting for Go server to register.")
        return False

    print("Python Backend: Go server has registered.")
    return True


def signal_go_ready(go_server_port: int):
    """
    Sends an HTTP GET request to the Go server to signal readiness.
    Retries a few times in case the Go server isn't immediately available.
    """
    ready_url = f"http://localhost:{go_server_port}/ready"
    parsed_url = urllib.parse.urlparse(ready_url)

    # Ensure hostname and port are not None
    host = parsed_url.hostname or "localhost"
    port = parsed_url.port or 80  # Default to port 80 if none

    max_retries = 5
    retry_delay_seconds = 2

    print(f"Python Backend: Attempting to signal Go server at {ready_url}")

    for attempt in range(max_retries):
        try:
            conn = http.client.HTTPConnection(host, port, timeout=10)
            conn.request("GET", parsed_url.path)
            response = conn.getresponse()
            status = response.status
            body = response.read().decode()

            if 200 <= status < 300:
                print(
                    f"Python Backend: Successfully signaled Go server. Status: {status}"
                )
                print(f"Python Backend: Go server response: {body}")
                conn.close()
                return True
            else:
                raise Exception(f"Unexpected status code: {status}")

        except Exception as e:
            print(
                f"Python Backend: Error signaling Go (attempt {attempt + 1}/{max_retries}): {e}"
            )
            if attempt < max_retries - 1:
                print(f"Python Backend: Retrying in {retry_delay_seconds} seconds...")
                time.sleep(retry_delay_seconds)  # type: ignore
            else:
                print(
                    f"Python Backend: Failed to signal Go server after {max_retries} attempts."
                )
                return False

    return False


class PythonCommandHandler(BaseHTTPRequestHandler):
    """
    Handles HTTP POST requests for registration, shutdown, and commands from the Go frontend.
    """

    def _send_json_response(self, status_code, data_dict):
        """Sends a JSON response with the given status code and data."""
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data_dict).encode("utf-8"))

    def do_POST(self):
        """Routes POST requests to the appropriate handler based on the URL path."""
        global PROJECT_DATA
        # --- Route 1: /register ---
        # Handles the initial registration from the Go application.
        if self.path == "/register":
            try:
                content_length = int(self.headers["Content-Length"])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode("utf-8"))
                port = data.get("go_server_port")
                if port:
                    global GO_SERVER_PORT
                    GO_SERVER_PORT = port
                    print(f"Python Command Server: Registered Go server on port {port}")
                    self._send_json_response(
                        200, {"status": "success", "message": "Go server registered."}
                    )
                else:
                    self._send_json_response(
                        400, {"status": "error", "message": "Missing 'go_server_port'."}
                    )
            except (json.JSONDecodeError, ValueError):
                self._send_json_response(
                    400, {"status": "error", "message": "Invalid or missing JSON body."}
                )
            return

        # --- Route 2: /shutdown ---
        # Handles the shutdown signal from the Go application. No request body is expected.
        elif self.path == "/shutdown":
            print("Python Command Server: Received shutdown signal from Go. Exiting.")
            self._send_json_response(
                200, {"status": "success", "message": "Shutdown acknowledged."}
            )

            # Use os.kill to send a SIGINT (Ctrl+C) signal to the current process.
            # This is the most reliable way to interrupt the httpd.serve_forever() loop.
            # It's done in a thread to allow the HTTP response to be sent first.
            threading.Thread(target=lambda: os.kill(os.getpid(), signal.SIGINT)).start()
            return

        # --- Route 3: /command ---
        elif self.path == "/command":
            # --- Authentication (Placeholder) ---
            # Your existing auth logic is preserved here.
            # if ENABLE_COMMAND_AUTH: ...
            if ENABLE_COMMAND_AUTH:
                auth_header = self.headers.get("Authorization")
                token_valid = False
                if auth_header and auth_header.startswith("Bearer ") and AUTH_TOKEN:
                    received_token = auth_header.split(" ")[1]
                    if received_token == AUTH_TOKEN:
                        token_valid = True

                if not token_valid:
                    print(
                        "Python Command Server: Unauthorized command attempt from Go."
                    )
                    self._send_json_response(
                        401, {"status": "error", "message": "Unauthorized"}
                    )
                    return
                print(
                    "Python Command Server: Go authenticated successfully for command."
                )
            else:
                print(
                    "Python Command Server: Command authentication is currently disabled."
                )

            command = None  # Initialize command here
            # --- Command Processing ---
            try:
                content_length = int(self.headers["Content-Length"])
                post_data_bytes = self.rfile.read(content_length)
                data = json.loads(post_data_bytes.decode("utf-8"))
                command = data.get("command")
                params = data.get("params", {})
                task_id = params.get("taskId")

                # Your existing command handling logic
                if command == "sync":
                    self._send_json_response(
                        200, {"status": "success", "message": "Sync command received."}
                    )
                    main(sync=True, task_id=task_id)
                    return  # Important: return after handling a command

                elif command == "makeFinalTimeline":
                    project_data_from_go_raw = params.get("projectData")
                    global MAKE_NEW_TIMELINE
                    MAKE_NEW_TIMELINE = params.get("makeNewTimeline", False)

                    if not project_data_from_go_raw:
                        self._send_json_response(
                            400, {"status": "error", "message": "Missing projectData."}
                        )
                        return

                    project_data_from_go = ProjectData(**project_data_from_go_raw)
                    self._send_json_response(
                        200,
                        {
                            "status": "success",
                            "message": "Final timeline generation started.",
                        },
                    )

                    if PROJECT_DATA:
                        PROJECT_DATA = apply_edits_from_go(
                            PROJECT_DATA, project_data_from_go
                        )
                    else:
                        PROJECT_DATA = project_data_from_go

                    main(sync=False, task_id=task_id)
                    return

                elif command == "saveProject":
                    self._send_json_response(
                        200,
                        {
                            "status": "success",
                            "message": "Project save command received.",
                        },
                    )
                    return

                elif command == "setPlayhead":
                    time_value = params.get("time")
                    if time_value is not None and set_timecode(time_value, task_id):
                        self._send_json_response(
                            200,
                            {
                                "status": "success",
                                "message": f"Playhead set to {time_value}.",
                            },
                        )
                    else:
                        self._send_json_response(
                            400,
                            {"status": "error", "message": "Could not set playhead."},
                        )
                    return

                # IMPORTANT: The shutdown command is now handled by the /shutdown endpoint, not here.
                # It has been removed from this section.

                else:
                    self._send_json_response(
                        400,
                        {"status": "error", "message": f"Unknown command: {command}"},
                    )
                    return

            except (json.JSONDecodeError, ValueError):
                print(
                    f"Python Command Server: Invalid JSON received from Go for /command. for command {command}"
                )
                self._send_json_response(
                    400, {"status": "error", "message": "Invalid JSON format."}
                )
            except Exception as e:
                print(f"Python Command Server: Error processing command: {e}")
                print(traceback.format_exc())
                self._send_json_response(
                    500,
                    {"status": "error", "message": f"Internal server error: {str(e)}"},
                )
            return

        # --- Fallback: Not Found ---
        # If the path is not /register, /shutdown, or /command
        else:
            self._send_json_response(
                404, {"status": "error", "message": "Endpoint not found."}
            )
            return


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


def init():
    global GO_SERVER_PORT
    global RESOLVE
    global FFMPEG
    global PYTHON_LISTEN_PORT
    global SERVER_INSTANCE_HOLDER

    print("2")

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-gp", "--go-port", type=int, default=0
    )  # port to communicate with http server
    parser.add_argument(
        "-lp", "--listen-on-port", type=int, default=0
    )  # port to receive commands from go
    parser.add_argument("--auth-token", type=str)  # authorization token
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("-s", "--sync", action="store_true")
    parser.add_argument("--standalone", action="store_true")
    parser.add_argument(
        "--launch-go",
        action="store_true",
        help="Launch the Go Wails application after Python backend starts.",
    )
    parser.add_argument(
        "--wails-dev",
        action="store_true",
        help="Launch the Go Wails application in development mode (wails dev).",
    )
    args = parser.parse_args()

    GO_SERVER_PORT = args.go_port
    FFMPEG = args.ffmpeg

    # --- FUTURE: Store shared secret ---
    # global EXPECTED_GO_COMMAND_TOKEN, ENABLE_COMMAND_AUTH
    # if args.auth-token:
    #     EXPECTED_GO_COMMAND_TOKEN = args.auth-token
    #     ENABLE_COMMAND_AUTH = True # Or make this a separate flag
    #     print(f"Python Command Server: Will expect Go to authenticate commands with the shared secret.")

    print(f"Python Backend: Go's server port: {args.go_port}")

    PYTHON_LISTEN_PORT = args.listen_on_port or find_free_port()
    if not PYTHON_LISTEN_PORT:
        PYTHON_LISTEN_PORT = find_free_port()
        print(
            f"Python Backend: No port specified, dynamically found and using free port: {PYTHON_LISTEN_PORT}"
        )
    else:
        print(
            f"Python Backend: Using specified port for command server: {PYTHON_LISTEN_PORT}"
        )

    if args.standalone:
        global STANDALONE_MODE
        STANDALONE_MODE = True
        main()
        return

    # Initialize the HTTP server for Go commands
    server_address = ("127.0.0.1", PYTHON_LISTEN_PORT)
    httpd = HTTPServer(server_address, PythonCommandHandler)
    SERVER_INSTANCE_HOLDER.append(httpd)
    print(
        f"Python Command Server: Listening for Go commands on http://127.0.0.1:{PYTHON_LISTEN_PORT}"
    )

    # Wait for Go to register, or launch Go if it doesn't register within a timeout.
    if GO_SERVER_PORT == 0:
        print("Python Backend: Go application did not yet start. Starting it...")
        if args.wails_dev:
            print(
                "Python Backend: Launching Go Wails application in development mode..."
            )
            project_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..")
            )

            # Check if 'wails' command is available
            try:
                subprocess.run(["wails", "version"], check=True, capture_output=True)
            except FileNotFoundError:
                print(
                    "Python Backend: Error: 'wails' command not found. Please ensure Wails CLI is installed and in your system's PATH."
                )
                sys.exit(1)
            except subprocess.CalledProcessError as e:
                print(
                    f"Python Backend: Error running 'wails version': {e.stdout.decode()}{e.stderr.decode()}"
                )
                sys.exit(1)

            # Pass the Python command port via an environment variable for wails dev
            env = os.environ.copy()
            env["WAILS_PYTHON_PORT"] = str(PYTHON_LISTEN_PORT)
            if sys.platform.startswith("linux"):
                env["GDK_BACKEND"] = "x11"
            wails_dev_command = ["wails", "dev"]
            try:
                # Use Popen to run in the background and not block the Python script
                # Capture stdout/stderr to help diagnose issues
                process = subprocess.Popen(
                    wails_dev_command,
                    cwd=project_root,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                print(
                    f"Python Backend: 'wails dev' launched with command: {wails_dev_command} in {project_root}"
                )

                # Read and print output in a non-blocking way (for debugging)
                def read_output(pipe, prefix):
                    for line in pipe:
                        print(f"[{prefix}] {line.strip()}")

                threading.Thread(
                    target=read_output,
                    args=(process.stdout, "WAILS_STDOUT"),
                    daemon=True,
                ).start()
                threading.Thread(
                    target=read_output,
                    args=(process.stderr, "WAILS_STDERR"),
                    daemon=True,
                ).start()

                print(
                    "Python Backend: Go application launch initiated. Waiting for Go to register."
                )

            except Exception as e:
                print(f"Python Backend: Error launching 'wails dev': {e}")
        else:
            print("Python Backend: Launching Go Wails application...")
            go_app_path = ""

            # Define potential paths for the HushCut binary
            # The first existing path found will be used
            potential_paths = []

            if sys.platform.startswith("darwin"):  # macOS
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(
                        os.path.join(
                            SCRIPT_DIR, "HushCut.app", "Contents", "MacOS", "HushCut"
                        )
                    ),
                    # 2. Check the .app bundle path (production)
                    os.path.abspath(
                        os.path.join(
                            SCRIPT_DIR,
                            "..",
                            "..",
                            "build",
                            "bin",
                            "HushCut.app",
                            "Contents",
                            "MacOS",
                            "HushCut",
                        )
                    ),
                    # 3. Check direct executable path (development build)
                    os.path.abspath(
                        os.path.join(SCRIPT_DIR, "..", "..", "build", "bin", "HushCut")
                    ),
                ]
            elif sys.platform.startswith("win"):  # Windows
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(os.path.join(SCRIPT_DIR, "HushCut.exe")),
                    # 2. Check build path
                    os.path.abspath(
                        os.path.join(
                            SCRIPT_DIR, "..", "..", "build", "bin", "HushCut.exe"
                        )
                    ),
                ]
            elif sys.platform.startswith("linux"):  # Linux
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(os.path.join(SCRIPT_DIR, "HushCut")),
                    # 2. Check build path
                    os.path.abspath(
                        os.path.join(SCRIPT_DIR, "..", "..", "build", "bin", "HushCut")
                    ),
                ]

            # Find the first valid path
            for path in potential_paths:
                print(f"Python Backend: Checking for binary at: {path}")
                if os.path.exists(path):
                    go_app_path = path
                    print(f"Python Backend: Found binary at: {go_app_path}")
                    break
                else:
                    print(f"Python Backend: Binary not found at: {path}")

            if not go_app_path:
                print(
                    "Python Backend: Error: Go Wails application 'HushCut' not found in any of the checked paths."
                )
            else:
                go_command = [go_app_path, "--python-port", str(PYTHON_LISTEN_PORT)]
                env = os.environ.copy()
                if sys.platform.startswith("linux"):
                    env["GDK_BACKEND"] = "x11"
                try:
                    subprocess.Popen(go_command, env=env)
                    print(
                        f"Python Backend: Go Wails application launched with command: {go_command} and env GDK_BACKEND={env.get('GDK_BACKEND')}"
                    )
                except Exception as e:
                    print(f"Python Backend: Error launching Go Wails application: {e}")
    else:
        # assume python process has been started by go application, signal readiness
        if not signal_go_ready(args.go_port):
            print(
                "Python Backend: CRITICAL - Could not signal main readiness to Go application."
            )
        # Consider how to handle this - maybe try to stop the command_server_thread or sys.exit(1)
        else:
            print(
                "Python Backend: Successfully signaled main readiness to Go application."
            )

    # The main loop for the Python script to keep running and handling Resolve API calls.
    # This loop will also allow the background HTTP server thread to process requests.
    print("Python Backend: Running. Command server is active in a background thread.")
    try:
        while not SHUTDOWN_EVENT.is_set():
            # Handle any incoming requests. This will block until a request comes in.
            # If no request comes in, it will block indefinitely. This is desired
            # as the script should only process commands when they arrive.
            httpd.handle_request()
            # Small sleep to prevent busy-waiting if no requests are coming in
            # and to allow Resolve's main loop to process other events.
            sleep(0.01)  # type: ignore  # type: ignore
    except KeyboardInterrupt:
        print("Python Backend: Keyboard interrupt detected. Shutting down.")
        SHUTDOWN_EVENT.set()
    except Exception as e:
        print(f"FATAL ERROR in command server loop: {e}", file=sys.stderr)
        traceback.print_exc()
    finally:
        print("Python Backend: Exiting main loop.")
        # Graceful Shutdown
        if SERVER_INSTANCE_HOLDER:
            httpd = SERVER_INSTANCE_HOLDER[0]
            print("Python Backend: Shutting down HTTP server...")
            httpd.server_close()  # Close the server socket

    print("Python Backend: Exiting.")

    # Wait for Go to register, or launch Go if it doesn't register within a timeout.
    go_registered = False
    start_time = time()
    while time() - start_time < 10:  # 10-second timeout for Go registration
        # Handle any incoming requests during the wait period
        httpd.handle_request()
        if GO_SERVER_PORT != 0:  # GO_SERVER_PORT is set by the /register endpoint
            print("Python Backend: Go application registered successfully.")
            go_registered = True
            break
        sleep(0.1)  # Check more frequently during the initial handshake

    if not go_registered:
        print(
            "Python Backend: Go application did not register within timeout. Launching Go Wails application..."
        )
        if args.wails_dev:
            print(
                "Python Backend: Launching Go Wails application in development mode..."
            )
            project_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..")
            )

            # Check if 'wails' command is available
            try:
                subprocess.run(["wails", "version"], check=True, capture_output=True)
            except FileNotFoundError:
                print(
                    "Python Backend: Error: 'wails' command not found. Please ensure Wails CLI is installed and in your system's PATH."
                )
                sys.exit(1)
            except subprocess.CalledProcessError as e:
                print(
                    f"Python Backend: Error running 'wails version': {e.stdout.decode()}{e.stderr.decode()}"
                )
                sys.exit(1)

            # Pass the Python command port via an environment variable for wails dev
            env = os.environ.copy()
            env["WAILS_PYTHON_PORT"] = str(PYTHON_LISTEN_PORT)
            if sys.platform.startswith("linux"):
                env["GDK_BACKEND"] = "x11"
            wails_dev_command = ["wails", "dev"]
            try:
                # Use Popen to run in the background and not block the Python script
                # Capture stdout/stderr to help diagnose issues
                process = subprocess.Popen(
                    wails_dev_command,
                    cwd=project_root,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                print(
                    f"Python Backend: 'wails dev' launched with command: {wails_dev_command} in {project_root}"
                )

                # Read and print output in a non-blocking way (for debugging)
                def read_output(pipe, prefix):
                    for line in pipe:
                        print(f"[{prefix}] {line.strip()}")

                threading.Thread(
                    target=read_output,
                    args=(process.stdout, "WAILS_STDOUT"),
                    daemon=True,
                ).start()
                threading.Thread(
                    target=read_output,
                    args=(process.stderr, "WAILS_STDERR"),
                    daemon=True,
                ).start()

                print(
                    "Python Backend: Go application launch initiated. Waiting for Go to register."
                )

            except Exception as e:
                print(f"Python Backend: Error launching 'wails dev': {e}")
        else:
            print("Python Backend: Launching Go Wails application...")
            go_app_path = ""

            # Define potential paths for the HushCut binary
            # The first existing path found will be used
            potential_paths = []

            if sys.platform.startswith("darwin"):  # macOS
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(os.path.join(SCRIPT_DIR, "HushCut")),
                    # 2. Check the .app bundle path (production)
                    os.path.abspath(
                        os.path.join(
                            SCRIPT_DIR,
                            "..",
                            "..",
                            "build",
                            "bin",
                            "HushCut.app",
                            "Contents",
                            "MacOS",
                            "HushCut",
                        )
                    ),
                    # 3. Check direct executable path (development build)
                    os.path.abspath(
                        os.path.join(SCRIPT_DIR, "..", "..", "build", "bin", "HushCut")
                    ),
                ]
            elif sys.platform.startswith("win"):  # Windows
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(os.path.join(SCRIPT_DIR, "HushCut.exe")),
                    # 2. Check build path
                    os.path.abspath(
                        os.path.join(
                            SCRIPT_DIR, "..", "..", "build", "bin", "HushCut.exe"
                        )
                    ),
                ]
            elif sys.platform.startswith("linux"):  # Linux
                potential_paths = [
                    # 1. Check current directory (same level as the script)
                    os.path.abspath(os.path.join(SCRIPT_DIR, "HushCut")),
                    # 2. Check build path
                    os.path.abspath(
                        os.path.join(SCRIPT_DIR, "..", "..", "build", "bin", "HushCut")
                    ),
                ]

            # Find the first valid path
            for path in potential_paths:
                print(f"Python Backend: Checking for binary at: {path}")
                if os.path.exists(path):
                    go_app_path = path
                    print(f"Python Backend: Found binary at: {go_app_path}")
                    break
                else:
                    print(f"Python Backend: Binary not found at: {path}")

            if not go_app_path:
                print(
                    "Python Backend: Error: Go Wails application 'HushCut' not found in any of the checked paths."
                )
            else:
                go_command = [go_app_path, "--python-port", str(PYTHON_LISTEN_PORT)]
                env = os.environ.copy()
                if sys.platform.startswith("linux"):
                    env["GDK_BACKEND"] = "x11"
                try:
                    subprocess.Popen(go_command, env=env)
                    print(
                        f"Python Backend: Go Wails application launched with command: {go_command} and env GDK_BACKEND={env.get('GDK_BACKEND')}"
                    )
                except Exception as e:
                    print(f"Python Backend: Error launching Go Wails application: {e}")

    # The main loop for the Python script to keep running and handling Resolve API calls.
    # This loop will also allow the background HTTP server thread to process requests.
    print("Python Backend: Running. Command server is active in a background thread.")
    try:
        while not SHUTDOWN_EVENT.is_set():
            # Handle any incoming requests. This will block until a request comes in.
            # If no request comes in, it will block indefinitely. This is desired
            # as the script should only process commands when they arrive.
            httpd.handle_request()
            # Small sleep to prevent busy-waiting if no requests are coming in
            # and to allow Resolve's main loop to process other events.
            sleep(0.01)  # type: ignore  # type: ignore
    except KeyboardInterrupt:
        print("Python Backend: Keyboard interrupt detected. Shutting down.")
        SHUTDOWN_EVENT.set()
    except Exception as e:
        print(f"FATAL ERROR in command server loop: {e}", file=sys.stderr)
        traceback.print_exc()
    finally:
        print("Python Backend: Exiting main loop.")
        # Graceful Shutdown
        if SERVER_INSTANCE_HOLDER:
            httpd = SERVER_INSTANCE_HOLDER[0]
            print("Python Backend: Shutting down HTTP server...")
            httpd.server_close()  # Close the server socket

    print("Python Backend: Exiting.")


if __name__ == "__main__":
    script_time = time()
    init()
