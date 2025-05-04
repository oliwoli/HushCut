#!/usr/bin/env python3

from __future__ import annotations
import math
import uuid
from statistics import median_grouped
from time import time
from typing import (
    Any,
    Dict,
    List,
    Literal,
    TypedDict,
)
import os
import sys
import subprocess
import re
from dotenv import load_dotenv
import json


from edit_silence import (
    create_edits_with_optional_silence,
    ClipData,
    SilenceInterval,
    EditInstruction,
)

import misc_utils


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
    edit_instructions: list[EditInstruction]


class FileData(TypedDict):
    properties: FileProperties
    silenceDetections: List[SilenceInterval]
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


class SourceMedia(TypedDict):
    file_path: str
    uuid: str


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
curr_timecode = timeline.GetCurrentTimecode()
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

source_media_files: list[SourceMedia] = []
media_pool_items: list[Any] = []
for item in audio_track_items:
    media_pool_item = item.GetMediaPoolItem()
    if not media_pool_item:
        continue
    if item in media_pool_items:
        continue
    media_pool_items.append(media_pool_item)
    filepath = media_pool_item.GetClipProperty("File Path")
    # linked_items = item.GetLinkedItems()
    # media_uuid = media_pool_item.GetUniqueId()
    file_path_uuid: str = misc_utils.uuid_from_path(filepath).hex

    source_media_item: SourceMedia = {
        "file_path": filepath,
        "uuid": file_path_uuid,
    }

    if source_media_item in source_media_files:
        continue
    source_media_files.append(source_media_item)

# print(f"Source media files: {source_media_files}")

if len(source_media_files) == 0:
    print("No file paths to process.")
    sys.exit(1)


silence_start_re = re.compile(r"silence_start: (?P<start>\d+\.?\d*)")
silence_end_re = re.compile(r"silence_end: (?P<end>\d+\.?\d*)")
silence_duration_re = re.compile(r"silence_duration: (?P<duration>\d+\.?\d*)")

silence_detect_time_start = time()

root_dir = os.path.dirname(os.path.abspath(__file__))


for file in source_media_files:
    filepath = file["file_path"]
    if not filepath:
        continue
    if not filepath or not os.path.exists(filepath):
        continue
    print(f"Processing file: {filepath}")
    basename = os.path.basename(filepath)
    print(f"Processing file: {basename}")

    wav_path = os.path.join(root_dir, "temp", f"{os.path.basename(file['uuid'])}.wav")
    print(f"wav_path: {wav_path}")

    # make the temp directory if it doesn't exist
    temp_dir = os.path.join(root_dir, "temp")
    if not os.path.exists(temp_dir):
        os.makedirs(temp_dir)
        print(f"Created temp directory: {temp_dir}")

    if not misc_utils.is_valid_audio(wav_path):
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
    current_silence: SilenceInterval = {"start": 0, "end": 0, "duration": 0}
    for line in stderr_output.splitlines():
        line = line.strip()
        if "silence_start:" in line:
            try:
                start_time = float(line.split("silence_start:")[1].strip())
                current_silence["start"] = misc_utils.sec_to_frames(
                    start_time, timeline_fps
                )
            except ValueError:
                continue
        elif "silence_end:" in line and "silence_duration:" in line:
            try:
                end_time = float(line.split("silence_end:")[1].split("|")[0].strip())
                current_silence["end"] = misc_utils.sec_to_frames(
                    end_time, timeline_fps
                )
            except ValueError:
                continue

            try:
                duration = float(
                    line.split("silence_duration:")[1].split("|")[0].strip()
                )
                current_silence["duration"] = misc_utils.sec_to_frames(
                    duration, timeline_fps
                )
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
execution_time_silence = end_time_silence - silence_detect_time_start


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
        clip_media_pool_item = item.GetMediaPoolItem()
        if not clip_media_pool_item:
            continue
        clip_file_path = clip_media_pool_item.GetClipProperty("File Path")
        if clip_file_path is None or clip_file_path == "":
            continue

        main_clip_data: ClipData = {
            "start_frame": clip_start_frame_timeline,
            "end_frame": clip_end_frame_timeline,
            "source_start_frame": clip_start_frame_source,
            "source_end_frame": clip_end_frame_source,
        }

        timeline_item: TimelineItem = get_timeline_item(item)
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
            edit_instructions: List[EditInstruction] = (
                create_edits_with_optional_silence(
                    main_clip_data, project_data[clip_file_path]["silenceDetections"]
                )
            )
            timeline_item["edit_instructions"] = edit_instructions
        timeline_items.append(timeline_item)

current_file_path = os.path.dirname(os.path.abspath(__file__))
json_output_path = os.path.join(current_file_path, "silence_detections.json")
misc_utils.export_to_json(project_data, json_output_path)


def add_markers_to_timeline() -> None:
    for filepath, file_data in project_data.items():
        print(
            f"Processing {filepath} with {len(file_data['silenceDetections'])} silence segments"
        )
        silence_detections: List[SilenceInterval] = file_data["silenceDetections"]
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


def make_edit_timeline() -> None:
    # make a new timeline
    edit_timeline_name = f"{timeline_name} - Silence Detection"
    media_pool = project.GetMediaPool()
    edit_timeline = media_pool.CreateEmptyTimeline(edit_timeline_name)
    edit_timeline_startframe = edit_timeline.GetStartFrame()
    # switch to the new timeline
    resolve.OpenPage("edit")
    # set the new timeline as current
    project.SetCurrentTimeline(edit_timeline)

    media_appends: list[Any] = []
    for file in media_pool_items:
        file_path = file.GetClipProperty("File Path")
        if file_path not in project_data:
            print(f"File {file_path} not in project data, skipping.")
            continue

        file_data = project_data[file_path]
        timeline_items = file_data["timelineItems"]

    FLOAT_EPSILON = 1e-9
    for timeline_item in timeline_items:
        edit_instructions = timeline_item["edit_instructions"]

        for edit in edit_instructions:
            timeline_start_frame = edit["start_frame"]
            source_start_time = edit["source_start_frame"]
            source_end_time_inclusive = edit["source_end_frame"]

            # Adjust source end frame assuming API expects exclusive end (+1 frame concept)
            api_source_end_exclusive = source_end_time_inclusive + 1.0

            # Safety check using original inclusive source values
            if source_end_time_inclusive <= source_start_time + FLOAT_EPSILON:
                # Optional: assert error
                raise ValueError(
                    f"Source end frame {source_end_time_inclusive} is not greater than start frame {source_start_time}"
                )

            clip_info = {
                "mediaPoolItem": media_pool_item,
                "startFrame": source_start_time,
                "endFrame": api_source_end_exclusive,  # Using adjusted exclusive end
                "recordFrame": timeline_start_frame,
                # Ensure mediaType is set correctly based on 'edit["enabled"]' and API requirements
                "mediaType": None,
                # Add trackIndex etc. if needed
            }
            media_appends.append(clip_info)

        # append = media_pool.AppendToTimeline([clip_info])

    # append all clips to the timeline
    # print(f"Appending {len(media_appends)} clips to timeline")
    # print(f"appends: {media_appends}")
    append = media_pool.AppendToTimeline(media_appends)
    print(f"Total cuts made: {len(append)}")

    # apply the timecode to the timeline
    print(f"Setting timeline timecode to {curr_timecode}")
    print(f"Timeline timecode: {edit_timeline.GetCurrentTimecode()}")
    edit_timeline.SetCurrentTimecode(curr_timecode)
    print(f"Timeline timecode after: {edit_timeline.GetCurrentTimecode()}")

    # print(append)

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
print(f"Script finished successfully in {execution_time:.2f} seconds.")

time_edit_start = time()
make_edit_timeline()
time_edit_end = time()
time_to_edit = time_edit_end - time_edit_start
print(f"Silence detection completed in {execution_time_silence:.2f} seconds.")
print(f"Edit timeline creation completed in {time_to_edit:.2f} seconds.")

export_xml_time = time()
edit_timeline = project.GetCurrentTimeline()

xml_file_path = os.path.join(current_file_path, f"temp_timeline_export2.xml")
export_timeline_to_xml(edit_timeline, file_path=xml_file_path)
export_xml_end_time = time()
export_xml_execution_time = export_xml_end_time - export_xml_time
print(
    f"Exported timeline to XML in {export_xml_execution_time:.2f} seconds. File path: {xml_file_path}"
)
