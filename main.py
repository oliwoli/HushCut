#!/usr/bin/env python3

from __future__ import annotations
import math
from statistics import median_grouped
from subprocess import CompletedProcess
from time import time
from typing import (
    Any,
    Dict,
    List,
    Literal,
    NotRequired,
    Optional,
    TypeAlias,
    TypedDict,
    Union,
)

import os
import sys
import subprocess
import re
from dotenv import load_dotenv
import json


def sec_to_frames(seconds: float, fps: float) -> int:
    """Converts time in seconds to frame number using ceiling."""
    if fps <= 0:
        raise ValueError("FPS must be positive")
    return int(seconds * fps)


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


# export timeline to XML
def export_timeline_to_xml(timeline: Any, file_path: str) -> None:
    """
    Export the current timeline to an XML file.

    Args:
        timeline (Any): The timeline object to export.
        file_path (str): The path where the XML file will be saved.
    """
    if not timeline:
        print("No timeline to export.")
        return

    # Assuming the Resolve API has a method to export timelines
    success = timeline.Export(file_path, resolve.EXPORT_FCP_7_XML)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


if not load_dotenv():
    raise FileNotFoundError(".env file not found.")

script_api_dir: str | None = os.getenv("RESOLVE_SCRIPT_API")
resolve_libs_dir: str | None = os.getenv("RESOLVE_LIBS")  # Get the libs directory path
if script_api_dir:
    resolve_modules_path = os.path.join(script_api_dir, "Modules")
    if resolve_modules_path not in sys.path:
        sys.path.insert(0, resolve_modules_path)  # Prepend to ensure it's checked first
        print(f"Added to sys.path: {resolve_modules_path}")
    else:
        print(f"Already in sys.path: {resolve_modules_path}")

try:
    from python_get_resolve import GetResolve
    import DaVinciResolveScript as bmd
except ImportError as e:
    print(f"Failed to import GetResolve or its dependencies: {e}")
    print("Check and ensure DaVinci Resolve installation is correct.")
    sys.exit(1)
except Exception as e:
    print(f"An unexpected error occurred during import: {e}")
    sys.exit(1)


resolve = GetResolve()  # noqa
script_start_time: float = time()
some_uuid: str = bmd.createuuid("randomString")  # probably need this later

if not resolve:
    print("Could not connect to DaVinci Resolve. Is it running?")
    # GetResolve already prints detailed errors if loading DaVinciResolveScript fails
    sys.exit(1)

current_page = resolve.GetCurrentPage()
if current_page != "edit":
    resolve.OpenPage("edit")
    print("Switched to edit page.")
else:
    print("Already on edit page.")

project = resolve.GetProjectManager().GetCurrentProject()

if not project:
    print("No project is currently open.")
    sys.exit(1)


class SilenceDetection(TypedDict):
    start: int
    end: int
    duration: int


class FileProperties(TypedDict):
    FPS: float


class TimelineProperties(TypedDict):
    name: str
    FPS: float
    item_usages: List[TimelineItem]


def get_item_id(item: Any) -> str:
    track_type_and_index = item.GetTrackTypeAndIndex()
    track_type = track_type_and_index[0]
    track_index = track_type_and_index[1]
    return f"{item.GetName()}-{track_type}-{track_index}"


def get_timeline_item(item: Any) -> TimelineItem:
    """Convert a timeline item to a dictionary."""
    name = item.GetName()
    start_frame = item.GetStart()
    track_type_and_index = item.GetTrackTypeAndIndex()
    track_type = track_type_and_index[0]
    track_index = track_type_and_index[1]
    return {
        "name": name,
        "id": f"{name}-{track_type}-{track_index}",
        "track_type": track_type,
        "track_index": track_index,
        "source_file_path": item.GetMediaPoolItem().GetClipProperty("File Path"),
        "start_frame": start_frame,
        "end_frame": item.GetEnd(),
        "source_start_frame": item.GetSourceStartFrame(),
        "source_end_frame": item.GetSourceEndFrame(),
        "duration": item.GetDuration(),
        "edit_instructions": [],
    }


class EditFrames(TypedDict):
    start_frame: int
    end_frame: int
    source_start_frame: int
    source_end_frame: int
    duration: int


class TimelineItem(TypedDict):
    name: str
    id: str
    track_type: Literal["video", "audio", "subtitle"]
    track_index: int
    source_file_path: str
    start_frame: int
    end_frame: int
    source_start_frame: int
    source_end_frame: int
    duration: int
    edit_instructions: list[EditFrames]


class FileData(TypedDict):
    properties: FileProperties
    silenceDetections: List[SilenceDetection]
    timelineItems: list[TimelineItem]


class Timeline(TypedDict):
    name: str
    fps: float
    video_track_items: List[TimelineItem]
    audio_track_items: List[TimelineItem]


class Track(TypedDict):
    name: str
    type: Literal["video", "audio"]
    index: int
    items: List[Any]


class ItemsByTracks(TypedDict):
    videotrack: List[Track]
    audiotrack: List[Track]


# Final structure:
ProjectData = Dict[str, FileData]
project_data: ProjectData = {}
timeline = project.GetCurrentTimeline()
items_by_tracks: ItemsByTracks = {
    "videotrack": [],
    "audiotrack": [],
}

if not timeline:
    print("No timeline is currently open.")
    sys.exit(1)
timeline_name = timeline.GetName()
timeline_fps = timeline.GetSetting("timelineFrameRate")
video_track_count = timeline.GetTrackCount("video")
video_track_items: list[Any] = []
for i in range(1, video_track_count + 1):
    track_items = timeline.GetItemListInTrack("video", i)
    track_name = timeline.GetTrackName("video", i)
    video_track_items.extend(track_items)

    items_by_tracks["videotrack"].append(
        {
            "name": track_name,
            "type": "video",
            "index": i,
            "items": track_items,
        }
    )

audio_track_count = timeline.GetTrackCount("audio")
audio_track_items: list[Any] = []
for i in range(1, audio_track_count + 1):
    track_items = timeline.GetItemListInTrack("audio", i)
    track_name = timeline.GetTrackName("audio", i)
    audio_track_items.extend(track_items)
    items_by_tracks["audiotrack"].append(
        {
            "name": track_name,
            "type": "audio",
            "index": i,
            "items": track_items,
        }
    )

tl_dict: Timeline = {
    "name": timeline_name,
    "fps": timeline_fps,
    "video_track_items": video_track_items,
    "audio_track_items": audio_track_items,
}

# print(f"video track items: {video_track_items}")
# print(f"video 1 GetStart: {video_track_items[0].GetStart()}")
# print(f"video 1 GetSourceStartFrame: {video_track_items[0].GetSourceStartFrame()}")
# print(f"video 1 GetMediaPoolItem(): {video_track_items[0].GetMediaPoolItem()}")

source_media_file_paths: list[str] = []
media_pool_items: list[Any] = []
for item in audio_track_items:
    media_pool_item = item.GetMediaPoolItem()
    if not media_pool_item:
        continue
    media_pool_items.append(media_pool_item)
    filepath = media_pool_item.GetClipProperty("File Path")
    # linked_items = item.GetLinkedItems()
    media_uuid = media_pool_item.GetUniqueId()
    if filepath in source_media_file_paths:
        continue
    source_media_file_paths.append(filepath)
print(f"Source media file paths: {source_media_file_paths}")

if len(source_media_file_paths) == 0:
    print("No file paths to process.")
    sys.exit(1)

silence_start_re = re.compile(r"silence_start: (?P<start>\d+\.?\d*)")
silence_end_re = re.compile(r"silence_end: (?P<end>\d+\.?\d*)")
silence_duration_re = re.compile(r"silence_duration: (?P<duration>\d+\.?\d*)")


for filepath in source_media_file_paths:
    wav_path = f"{filepath}.wav"

    if is_valid_audio(wav_path):
        print(f"Skipping extraction, valid audio already exists: {wav_path}")
    else:
        print(f"Extracting audio from: {filepath}")
        audio_extract_cmd = [
            "ffmpeg",
            "-y",
            "-i",
            filepath,
            "-vn",
            "-acodec",
            "pcm_s16le",
            wav_path,
        ]
        subprocess.run(
            audio_extract_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )

    print(f"Running silence detection on: {wav_path}")
    silence_detect_cmd = [
        "ffmpeg",
        "-i",
        wav_path,
        "-af",
        "silencedetect=n=-20dB:d=0.5",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(
        silence_detect_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    stderr_output = proc.stderr
    # print(f"Output: {stderr_output}")
    file_data = []
    current_silence: SilenceDetection = {"start": 0, "end": 0, "duration": 0}
    for line in stderr_output.splitlines():
        line = line.strip()
        if "silence_start:" in line:
            try:
                start_time = float(line.split("silence_start:")[1].strip())
                current_silence["start"] = sec_to_frames(start_time, timeline_fps)
            except ValueError:
                continue
        elif "silence_end:" in line and "silence_duration:" in line:
            try:
                end_time = float(line.split("silence_end:")[1].split("|")[0].strip())
                current_silence["end"] = sec_to_frames(end_time, timeline_fps)
            except ValueError:
                continue

            try:
                duration = float(
                    line.split("silence_duration:")[1].split("|")[0].strip()
                )
                current_silence["duration"] = sec_to_frames(duration, timeline_fps)
                file_data.append(current_silence)
                current_silence = {
                    "start": 0,
                    "end": 0,
                    "duration": 0,
                }
            except ValueError:
                continue

    project_data[filepath] = {
        "properties": {
            "FPS": timeline_fps,
        },
        "silenceDetections": [],
        "timelineItems": [],
    }
    project_data[filepath]["silenceDetections"] = file_data
    print(f"Detected {len(file_data)} silence segments in {filepath}")


end_time_silence = time()
execution_time_silence = end_time_silence - start_time
print(f"Silence detection completed in {execution_time_silence:.2f} seconds.")


# export silence detections as json
def export_project_data_to_json(project_data: ProjectData, output_path: str) -> None:
    """
    Export silence detections to a JSON file.

    Args:
        project_data (dict): Main project data.
        output_path (str): Path to save the JSON file.
    """
    with open(output_path, "w") as json_file:
        json.dump(project_data, json_file, indent=4)
    print(f"Silence detections exported to {output_path}")


for track in items_by_tracks["audiotrack"]:
    items: List[Any] = track["items"]
    track_index = track["index"]
    if len(items) == 0:
        continue
    print(f"Audio track {track_index} has {len(items)} items.")
    print(f"Track name: {track['name']}")
    print(f"Track type: {track['type']}")
    print(f"Track index: {track['index']}")
    print(f"Audio track items: {items}")
    for item in items:
        clip_name = item.GetName()
        clip_start_frame_timeline = item.GetStart()
        clip_start_frame_source = item.GetSourceStartFrame()
        clip_end_frame_timeline = item.GetEnd()
        clip_end_frame_source = item.GetSourceEndFrame()
        clip_duration = item.GetDuration()
        clip_linked_items = item.GetLinkedItems()
        clip_file_path = item.GetMediaPoolItem().GetClipProperty("File Path")

        timeline_item = get_timeline_item(item)
        timeline_items = project_data[clip_file_path]["timelineItems"]

        linked_items_file_paths = [
            item.GetMediaPoolItem().GetClipProperty("File Path")
            for item in clip_linked_items
        ]
        # if this clips filepath or linked items filepath is in project_data, apply markers to clip
        if any(
            filepath in project_data
            for filepath in [clip_file_path] + linked_items_file_paths
        ):
            print(f"Clip {clip_name} has silence detections.")

            # # remove existing markers
            # current_markers = item.GetMarkers()
            # for marker in current_markers:
            #     item.DeleteMarkerAtFrame(marker)

            # add markers to clip
            file_data = project_data[clip_file_path]
            for i, detection in enumerate(file_data["silenceDetections"]):
                start = detection["start"]
                end = detection["end"]
                duration_frames = detection["duration"]
                shifted_start = start - clip_start_frame_source
                shifted_end = end - clip_start_frame_source

                if start > clip_duration:
                    print("reached end of clip")
                    break

                # marker = item.AddMarker(
                #     shifted_start,
                #     "Red",
                #     f"Silence {clip_start_frame_timeline} - {clip_end_frame_timeline}",
                #     f"Silence detected from {clip_start_frame_timeline} to {clip_end_frame_timeline}",
                #     duration_frames,
                # )
                # print(
                #     f"Added marker to clip {clip_name} from {shifted_start} to {clip_end_frame_timeline}: {marker}"
                # )

                if i == 0:
                    print("FIRST DETECTION")
                    continue

                # absolute start time in frames of the clip in the timeline
                clip_start_tl = timeline_item["start_frame"]

                if i == 1:
                    start_frame = clip_start_tl
                    end_frame = clip_start_tl + (
                        start - file_data["silenceDetections"][i - 1]["end"]
                    )

                else:
                    last_edit = timeline_item["edit_instructions"][-1]

                    start_frame = last_edit["end_frame"]
                    end_frame = last_edit["end_frame"] + (
                        start - file_data["silenceDetections"][i - 1]["end"]
                    )

                timeline_item["edit_instructions"].append(
                    {
                        "start_frame": start_frame,
                        "end_frame": end_frame,
                        "source_start_frame": file_data["silenceDetections"][i - 1][
                            "end"
                        ],
                        "source_end_frame": start,
                        "duration": end_frame - start_frame,
                    }
                )

        timeline_items.append(timeline_item)

current_file_path = os.path.dirname(os.path.abspath(__file__))
json_output_path = os.path.join(current_file_path, "silence_detections.json")
export_project_data_to_json(project_data, json_output_path)


def add_markers_to_timeline() -> None:
    for filepath, file_data in project_data.items():
        print(
            f"Processing {filepath} with {len(file_data['silenceDetections'])} silence segments"
        )
        silence_detections: List[SilenceDetection] = file_data["silenceDetections"]
        for detection in silence_detections:
            start = detection["start"]
            end = detection["end"]
            duration_frames = detection["duration"]
            duration_seconds = detection["duration"]
            print(
                f"Adding marker from {start} to {end} (Duration frames: {duration_frames})"
            )

            # Add markers to the timeline
            timeline.AddMarker(
                start,
                "Green",
                f"Silence {start} - {end}",
                f"Silence detected from {start} to {end} (Duration frames: {duration_frames})",
                duration_frames,
            )
            # print(f"Added marker for silence from {start} to {end}")


# add_markers_to_timeline()

# stills_dir = project.GetSetting("colorGalleryStillsLocation")
# print(f"Stills directory: {stills_dir}")

xml_file_path = os.path.join(current_file_path, f"temp_timeline_export2.xml")
print(f"Exporting timeline to {xml_file_path}")
export_timeline_to_xml(timeline, file_path=xml_file_path)


def make_edit_timeline() -> None:
    # make a new timeline
    edit_timeline_name = f"{timeline_name} - Silence Detection"
    media_pool = project.GetMediaPool()
    edit_timeline = media_pool.CreateEmptyTimeline(edit_timeline_name)
    # switch to the new timeline
    resolve.OpenPage("edit")
    # set the new timeline as current
    project.SetCurrentTimeline(edit_timeline)

    for file in media_pool_items:
        file_path = file.GetClipProperty("File Path")
        if file_path not in project_data:
            print(f"File {file_path} not in project data, skipping.")
            continue

        file_data = project_data[file_path]
        timeline_items = file_data["timelineItems"]

        for timeline_item in timeline_items:
            edit_instructions = timeline_item["edit_instructions"]
            for edit in edit_instructions:
                start_frame = edit["start_frame"]
                end_frame = edit["end_frame"]
                source_start_frame = edit["source_start_frame"]
                source_end_frame = edit["source_end_frame"]
                duration = edit["duration"]

                # Create a new clip info for the timeline
                clip_info: Dict[str, Any] = {
                    "mediaPoolItem": file,
                    "startFrame": source_start_frame,
                    "endFrame": source_end_frame,
                    "recordFrame": start_frame,
                }
                print(f"Appending clip info: {clip_info}")
                # Append the clip to the timeline
                append = media_pool.AppendToTimeline([clip_info])

        # clip_info = {
        #     "mediaPoolItem": file,  # The MediaPoolItem you're appending
        #     "startFrame": 10,  # In point (in source media frame numbers)
        #     "endFrame": 5000,  # Out point (exclusive)
        #     "recordFrame": 114206,  # Position on the timeline to place the clip (in timeline frame numbers)
        #     # "trackIndex": 1,  # Optional: which track to insert into
        #     # "mediaType": 1,  # Optional: 1 = video, 2 = audio
        # }
        # append = media_pool.AppendToTimeline([clip_info])
        # print(append)


full_end_time = time()
execution_time = full_end_time - script_start_time

current_time_code = timeline.GetCurrentTimecode()
print(f"Current timecode: {current_time_code}")

print(f"Script finished successfully in {execution_time:.2f} seconds.")
