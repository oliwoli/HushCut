#!/usr/bin/env python3

from __future__ import annotations
from collections import Counter
import json

import threading
from time import time, sleep
import traceback
from typing import (
    Any,
    Dict,
    List,
    Literal,
    Optional,
    Tuple,
    TypedDict,
    Union,
)
import os
import sys
import subprocess
import argparse

from concurrent.futures import ThreadPoolExecutor, as_completed
from uuid import uuid4

from edit_silence import (
    create_edits_with_optional_silence,
    ClipData,
    SilenceInterval,
    EditInstruction,
)

import misc_utils

from local_types import (
    Timeline,
    TimelineItem,
    FileSource,
    ProjectData,
)

import globalz

from otio_as_bridge import unify_linked_items_in_project_data

# from project_orga import (
#     map_media_pool_items_to_folders,
#     MediaPoolItemFolderMapping,
#     move_clips_to_temp_folder,
#     restore_clips_from_temp_folder,
# )

import requests
from http.server import HTTPServer, BaseHTTPRequestHandler


# GLOBALS
TEMP_DIR: str = os.path.join(os.path.dirname(__file__), "..", "wav_files")
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

STANDALONE_MODE = False
RESOLVE = None


def send_message_to_go(message_type: str, payload: Any, task_id: Optional[str] = None):
    global GO_SERVER_PORT
    if GO_SERVER_PORT == 0:
        print(
            "Python Error: Go server port not configured. Cannot send message to Go.",
            flush=True,
        )
        return False

    url = f"http://localhost:{GO_SERVER_PORT}/msg"  # Your Go endpoint for general messages

    message_data = {"type": message_type, "payload": payload}
    try:
        headers = {"Content-Type": "application/json"}

        # This is an independent HTTP request from Python to Go
        def fallback_serializer(obj):
            return "<BMDObject>"

        response = requests.post(
            url,
            data=json.dumps(message_data, default=fallback_serializer),
            headers=headers,
            params={"task_id": task_id},
            timeout=5,
        )  # 5s timeout
        response.raise_for_status()
        print(
            f"Python (to Go): Message type '{message_type}' sent. Task id: {task_id}. Go responded: {response.status_code}",
            flush=True,
        )
        return True
    except requests.exceptions.RequestException as e:
        print(
            f"Python (to Go): Error sending message type '{message_type}': {e}",
            flush=True,
        )
        print(f"Payload: {payload}")
        return False


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

    script_api_dir: str | None = os.getenv("RESOLVE_SCRIPT_API")
    if script_api_dir:
        resolve_modules_path = os.path.join(script_api_dir, "Modules")
        if resolve_modules_path not in sys.path:
            sys.path.insert(
                0, resolve_modules_path
            )  # Prepend to ensure it's checked first
            print(f"Added to sys.path: {resolve_modules_path}")
        else:
            print(f"Already in sys.path: {resolve_modules_path}")

    try:
        from python_get_resolve import GetResolve

        # import DaVinciResolveScript as bmd
    except ImportError as e:
        resolve_import_error_msg(e, task_id)
        return None
    except FileNotFoundError as e:
        resolve_import_error_msg(e, task_id)
        return None
    except Exception as e:
        resolve_import_error_msg(e, task_id)
        return None
    resolve_obj = GetResolve()

    if not resolve_obj:
        resolve_import_error_msg(
            e=Exception("Failed to import DaVinci Resolve Python API.", task_id)
        )
        return None

    RESOLVE = resolve_obj


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
    success = timeline.Export(file_path, RESOLVE.EXPORT_FCP_7_XML)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


# export timeline to XML
def export_timeline_to_otio(timeline: Any, file_path: str) -> None:
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
    success = timeline.Export(file_path, RESOLVE.EXPORT_OTIO)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


# if not load_dotenv():
#     raise FileNotFoundError(".env file not found.")


class AudioFromVideo(TypedDict):
    video_bmd_media_pool_item: Any
    video_file_path: str
    audio_file_path: str
    audio_file_uuid: str
    audio_file_name: str
    silence_intervals: List[SilenceInterval]


def extract_audio(file: Any, target_folder: str) -> Optional[AudioFromVideo]:
    filepath = file.get("file_path")
    if not filepath or not os.path.exists(filepath):
        return

    wav_path = os.path.join(target_folder, f"{file['uuid']}.wav")

    audio_from_video: AudioFromVideo = {
        "audio_file_name": os.path.basename(wav_path),
        "audio_file_path": wav_path,
        "audio_file_uuid": file["uuid"],
        "video_file_path": filepath,
        "video_bmd_media_pool_item": file["bmd_media_pool_item"],
        "silence_intervals": [],
    }

    if misc_utils.is_valid_audio(wav_path):
        return audio_from_video

    print(f"Extracting audio from: {filepath}")
    audio_extract_cmd = [
        "ffmpeg",
        "-y",
        "-i",
        filepath,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        wav_path,
    ]
    subprocess.run(audio_extract_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return audio_from_video


def process_audio_files(
    audio_source_files: list[FileSource], target_folder: str, max_workers=4
) -> list[AudioFromVideo]:
    """Runs audio extraction in parallel using ThreadPoolExecutor."""
    start_time = time()
    audios_from_video: list[AudioFromVideo] = []

    print(f"Starting audio extraction with {max_workers} workers.")
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(extract_audio, file, target_folder)
            for file in audio_source_files
        ]

        for future in as_completed(futures):
            result = future.result()
            if result:  # Only add valid paths
                audios_from_video.append(result)

    print(
        f"Audio extraction for {len(audio_source_files)} files completed in {time() - start_time:.2f} seconds."
    )
    return audios_from_video


def detect_silence_in_file(audio_file: AudioFromVideo, timeline_fps) -> AudioFromVideo:
    """Runs FFmpeg silence detection on a single WAV file and returns intervals."""
    processed_audio = audio_file["audio_file_path"]
    silence_detect_cmd = [
        "ffmpeg",
        "-i",
        processed_audio,
        "-af",
        "silencedetect=n=-20dB:d=1.0",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(
        silence_detect_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stderr_output = proc.stderr

    silence_data: list[SilenceInterval] = []
    current_silence: SilenceInterval = {"start": 0, "end": 0}
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
                silence_data.append(current_silence)
                current_silence = {"start": 0, "end": 0}
            except ValueError:
                continue
    audio_file["silence_intervals"] = silence_data
    return audio_file


def detect_silence_parallel(
    processed_audio: list[AudioFromVideo], timeline_fps, max_workers=4
) -> dict[str, AudioFromVideo]:
    """Runs silence detection in parallel across audio files."""
    results: dict[str, AudioFromVideo] = {}

    print(f"Starting silence detection with {max_workers} workers.")
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(detect_silence_in_file, audio_from_video, timeline_fps)
            for audio_from_video in processed_audio
        ]

        for future in as_completed(futures):
            final_audio: AudioFromVideo = future.result()
            results[final_audio["video_file_path"]] = final_audio

    return results


ResolvePage = Literal["edit", "color", "fairlight", "fusion", "deliver"]


def switch_to_page(page: ResolvePage) -> None:
    global RESOLVE
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
        track_items = timeline.GetItemListInTrack(track_type, i)
        for item in track_items:
            start_frame = item.GetStart(True)
            item_name = item.GetName()
            media_pool_item = item.GetMediaPoolItem()
            left_offset = item.GetLeftOffset(True)
            duration = item.GetDuration(True)
            source_start_float = left_offset
            source_end_float = left_offset + duration

            source_file_path: str = (
                media_pool_item.GetClipProperty("File Path") if media_pool_item else ""
            )
            timeline_item: TimelineItem = {
                "bmd_item": item,
                "bmd_mpi": None,
                "duration": 0,  # unused, therefore 0 #item.GetDuration(),
                "name": item_name,
                "edit_instructions": [],
                "start_frame": start_frame,
                "end_frame": item.GetEnd(True),
                "id": get_item_id(item, item_name, start_frame, track_type, i),
                "track_type": track_type,
                "track_index": i,
                "source_file_path": source_file_path,
                "processed_file_name": misc_utils.uuid_from_path(source_file_path).hex,
                "source_start_frame": source_start_float,
                "source_end_frame": source_end_float,
            }
            items.append(timeline_item)
    return items


def simple_get_items_by_tracktype(
    track_type: Literal["video", "audio"], timeline: Any
) -> list[Dict]:  # Using Dict for simplicity as TimelineItem structure is complex
    """Fetches all timeline items of a specific type from the timeline."""
    items: list[Dict] = []
    track_count = timeline.GetTrackCount(track_type)
    for i in range(1, track_count + 1):
        # Ensure we handle a None return from the API call
        track_items = timeline.GetItemListInTrack(track_type, i) or []
        for item in track_items:
            # For verification, we only need a few key properties
            timeline_item = {
                "bmd_item": item,
                "track_type": track_type,
                "track_index": i,
                "start_frame": round(item.GetStart()),  # Use rounded integer frames
            }
            items.append(timeline_item)
    return items


def _verify_timeline_state(timeline: Any, expected_clips: List[Dict]) -> bool:
    """
    Verifies that the clips on the timeline match the expected state.

    Args:
        timeline: The DaVinci Resolve timeline object.
        expected_clips: A list of clip info dictionaries that were intended to be appended.

    Returns:
        True if the timeline state is correct, False otherwise.
    """
    print("Verifying timeline state...")
    # 1. Build the "checklist" of expected cuts.
    # We use a Counter to handle multiple clips starting at the same frame on the same track.
    expected_cuts = Counter()
    for clip in expected_clips:
        key = (clip["mediaType"], clip["trackIndex"], clip["recordFrame"])
        expected_cuts[key] += 1

    # 2. Get the actual clips from the timeline.
    actual_video_items = get_items_by_tracktype("video", timeline)
    actual_audio_items = get_items_by_tracktype("audio", timeline)

    # 3. "Check off" items from our checklist.
    for item in actual_video_items + actual_audio_items:
        media_type = 1 if item["track_type"] == "video" else 2
        key = (media_type, item["track_index"], item["start_frame"])
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


def get_source_media_from_timeline_item(
    timeline_item: TimelineItem,
) -> Union[FileSource, None]:
    media_pool_item = timeline_item["bmd_item"].GetMediaPoolItem()
    if not media_pool_item:
        return None
    filepath = media_pool_item.GetClipProperty("File Path")
    if not filepath:
        # print(f"Audio mapping: {media_pool_item.GetAudioMapping()}")
        return None
    file_path_uuid: str = misc_utils.uuid_from_path(filepath).hex
    source_media_item: FileSource = {
        "file_path": filepath,
        "uuid": file_path_uuid,
        "bmd_media_pool_item": media_pool_item,
    }
    return source_media_item


def resync_with_resolve() -> bool:
    global RESOLVE
    RESOLVE = get_resolve()
    if not RESOLVE:
        return False
    return True


def assign_bmd_mpi_to_items(items: list[TimelineItem]) -> None:
    for item in items:
        item["bmd_mpi"] = item["bmd_item"].GetMediaPoolItem()


def get_project_data(project, timeline) -> Tuple[bool, str | None]:
    # switch_to_page("edit")
    timeline_name = timeline.GetName()
    timeline_fps = timeline.GetSetting("timelineFrameRate")

    video_track_items: list[TimelineItem] = get_items_by_tracktype("video", timeline)
    audio_track_items: list[TimelineItem] = get_items_by_tracktype("audio", timeline)

    tl_dict: Timeline = {
        "name": timeline_name,
        "fps": timeline_fps,
        "video_track_items": video_track_items,
        "audio_track_items": audio_track_items,
    }

    # Final structure:
    globalz.PROJECT_DATA = {
        "project_name": project.GetName(),
        "timeline": tl_dict,
        "files": {},
    }

    seen_uuids: list[str] = []
    audio_source_files: list[FileSource] = []  # includes duplicates (true to timeline)
    audio_sources_set: list[FileSource] = []  # no duplicates
    for item in audio_track_items:
        source_media_item = get_source_media_from_timeline_item(item)
        if not source_media_item:
            continue
        item["bmd_mpi"] = source_media_item["bmd_media_pool_item"]
        audio_source_files.append(source_media_item)
        if source_media_item["uuid"] in seen_uuids:
            continue
        seen_uuids.append(source_media_item["uuid"])
        audio_sources_set.append(source_media_item)

    if len(audio_source_files) == 0:
        return False, "No files to process"

    print(f"Source media files count: {len(audio_source_files)}")

    assign_bmd_mpi_to_items(video_track_items)
    # assign_bmd_mpi_to_items(audio_track_items)

    processed_audio_paths: list[AudioFromVideo] = []
    # if at this point, audio source files is the same as PROJECT_DATA, we don't need to reprocess/check if the files exist
    if globalz.PROJECT_DATA:
        project_data_source_files = list(globalz.PROJECT_DATA["files"].keys())
        print(f"Project data source files count: {len(project_data_source_files)}")
        curr_audio_source_files = [file["file_path"] for file in audio_sources_set]
        print(f"Current audio source files count: {len(curr_audio_source_files)}")

        curr_audio_source_files.sort(key=lambda x: x.lower())
        project_data_source_files.sort(key=lambda x: x.lower())

        if curr_audio_source_files == project_data_source_files:
            print(
                "Audio source files are the same as PROJECT_DATA, skipping processing."
            )
        else:
            processed_audio_paths = process_audio_files(audio_sources_set, TEMP_DIR)
    else:
        processed_audio_paths = process_audio_files(audio_sources_set, TEMP_DIR)

    if STANDALONE_MODE:
        silence_intervals_by_file = detect_silence_parallel(
            processed_audio_paths, timeline_fps
        )

    for file in audio_source_files:
        audio_path = file["file_path"]
        globalz.PROJECT_DATA["files"][audio_path] = {
            "properties": {
                "FPS": timeline_fps,
            },
            "silenceDetections": [],
            "timelineItems": [],
            "fileSource": file,
        }

        if STANDALONE_MODE:
            if audio_path not in silence_intervals_by_file:
                print(f"No silence detected in {audio_path}")
                continue

            silence_intervals: AudioFromVideo = silence_intervals_by_file[audio_path]

            globalz.PROJECT_DATA["files"][audio_path]["silenceDetections"] = (
                silence_intervals["silence_intervals"]
            )
            print(f"Detected {len(silence_intervals)} silence segments in {audio_path}")

    start_calc_edits = time()
    for item in globalz.PROJECT_DATA["timeline"]["audio_track_items"]:
        bmd_item = item["bmd_item"]
        clip_start_frame_timeline = item["start_frame"]
        clip_start_frame_source = item["source_start_frame"]
        clip_end_frame_timeline = item["end_frame"]
        clip_end_frame_source = item["source_end_frame"]
        # clip_linked_items = bmd_item.GetLinkedItems()
        clip_media_pool_item = bmd_item.GetMediaPoolItem()
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
        timeline_items: list[TimelineItem] = globalz.PROJECT_DATA["files"][
            clip_file_path
        ]["timelineItems"]

        silence_detections: Union[List[SilenceInterval], None] = globalz.PROJECT_DATA[
            "files"
        ][clip_file_path]["silenceDetections"]

        if silence_detections:
            edit_instructions: List[EditInstruction] = (
                create_edits_with_optional_silence(main_clip_data, silence_detections)
            )
            item["edit_instructions"] = edit_instructions
            timeline_items.append(item)

    print(f"It took {time() - start_calc_edits:.2f} seconds to calculate edits")

    # json_ex_start = time()
    # json_output_path = os.path.join(TEMP_DIR, "silence_detections.json")
    # misc_utils.export_to_json(globalz.PROJECT_DATA, json_output_path)
    # print(f"it took {time() - json_ex_start:.2f} seconds to export to JSON")

    return True, None


def merge_project_data(project_data_from_go: ProjectData) -> None:
    """Use everything from go except keys which values are <BMDObject> (string)"""
    if not globalz.PROJECT_DATA:
        globalz.PROJECT_DATA = {}
    for key, value in project_data_from_go.items():
        if value == "<BMDObject>":
            continue
        globalz.PROJECT_DATA[key] = value

    return


def deep_merge_bmd_aware(target_dict: ProjectData, source_dict: dict) -> None:
    for key, source_value in source_dict.items():
        if source_value == "<BMDObject>":
            if key not in target_dict or target_dict.get(key) is None:
                target_dict[key] = source_value
            continue

        if (
            isinstance(source_value, dict)
            and key in target_dict
            and isinstance(target_dict.get(key), dict)
        ):
            deep_merge_bmd_aware(target_dict[key], source_value)
            continue

        if (
            isinstance(source_value, list)
            and key in target_dict
            and isinstance(target_dict.get(key), list)
        ):
            target_list = target_dict[key]
            source_list = source_value

            can_smart_merge_lists = all(
                isinstance(item, dict) and "id" in item for item in source_list
            ) and all(isinstance(item, dict) and "id" in item for item in target_list)

            if can_smart_merge_lists:
                target_items_by_id = {item["id"]: item for item in target_list}
                new_merged_list = []
                for s_item in source_list:
                    item_id = s_item["id"]
                    if item_id in target_items_by_id:
                        merged_item_copy = target_items_by_id[item_id].copy()
                        deep_merge_bmd_aware(merged_item_copy, s_item)
                        new_merged_list.append(merged_item_copy)
                    else:
                        new_merged_list.append(s_item)
                target_dict[key] = new_merged_list
            else:
                target_dict[key] = source_value
            continue

        target_dict[key] = source_value


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


def main(sync: bool = False, task_id: str = "") -> Optional[bool]:
    global RESOLVE
    global TEMP_DIR
    global PROJECT
    global TIMELINE
    global MEDIA_POOL
    script_start_time: float = time()

    if not RESOLVE:
        task_id = task_id or ""
        get_resolve(task_id)

    if not RESOLVE:
        globalz.PROJECT_DATA = {}
        alert_title = "DaVinci Resolve Error"
        message = "Could not connect to DaVinci Resolve. Is it running?"
        send_result_with_alert(alert_title, message, task_id)

        send_message_to_go(
            "projectData",
            globalz.PROJECT_DATA,
        )
        return False

    if not RESOLVE.GetProjectManager():
        PROJECT = None
        alert_title = "DaVinci Resolve Error"
        message = "Could not connect to DaVinci Resolve. Is it running?"
        send_result_with_alert(alert_title, message, task_id)

    PROJECT = RESOLVE.GetProjectManager().GetCurrentProject()

    if not PROJECT:
        globalz.PROJECT_DATA = None
        MEDIA_POOL = None
        alert_title = "No open project"
        message = "Please open a project and open a timeline."

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
        send_message_to_go(
            "projectData",
            globalz.PROJECT_DATA,
        )
        return False

    TIMELINE = PROJECT.GetCurrentTimeline()
    if not TIMELINE:
        globalz.PROJECT_DATA = None
        message = "Please open a timeline."

        response_payload = {
            "status": "error",
            "message": message,  # Overall message for the sync operation
            "data": globalz.PROJECT_DATA,
            "shouldShowAlert": True,
            "alertTitle": "No Open Timeline",
            "alertMessage": message,  # Specific message for the alert
            "alertSeverity": "error",
        }

        send_message_to_go("taskResult", response_payload, task_id=task_id)
        return False

    if sync or not globalz.PROJECT_DATA:
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
            send_message_to_go("taskResult", response_payload, task_id=task_id)
            return
        print(f"Timeline Name: {globalz.PROJECT_DATA['timeline']['name']}")

    if sync:
        print("just syncing, exiting")
        print(f"it took {time() - script_start_time:.2f} seconds for script to finish")

        response_payload = {
            "status": "success",
            "message": "Sync successful!",
            "data": globalz.PROJECT_DATA,
        }

        send_message_to_go(
            message_type="taskResult", payload=response_payload, task_id=task_id
        )
        return

    # safety check: do we have bmd items?
    all_timeline_items = (
        globalz.PROJECT_DATA["timeline"]["video_track_items"]
        + globalz.PROJECT_DATA["timeline"]["audio_track_items"]
    )

    if not all_timeline_items:
        print("critical error, can't continue")
        return

    some_bmd_item = all_timeline_items[0]["bmd_item"]
    if not some_bmd_item or isinstance(some_bmd_item, str):
        print("critical error, can't continue")
        return

    # export state of current timeline to otio, EXPENSIVE
    input_otio_path = os.path.join(TEMP_DIR, "temp-timeline.otio")
    export_timeline_to_otio(TIMELINE, file_path=input_otio_path)
    print(f"Exported timeline to OTIO in {input_otio_path}")

    unify_edits = unify_linked_items_in_project_data(input_otio_path)

    append_and_link_timeline_items()

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


def _append_and_link(
    timeline: Any, media_pool: Any, timeline_items: List[TimelineItem]
) -> Tuple[List[Tuple[Dict, Tuple[int, int]]], List[Any]]:
    clips_to_process: List[Tuple[Dict, Tuple[int, int]]] = []
    for item in timeline_items:
        link_id = item.get("link_group_id")
        if link_id is None:
            continue
        media_type = 1 if item["track_type"] == "video" else 2
        for i, edit in enumerate(item.get("edit_instructions", [])):
            if not edit.get("enabled", False):
                continue
            record_frame = round(edit.get("start_frame", 0))
            end_frame = round(edit.get("end_frame", 0))
            duration_frames = end_frame - record_frame
            if duration_frames < 1:
                continue
            source_start = edit.get("source_start_frame", 0)
            source_end = source_start + duration_frames

            if not item["bmd_item"] or isinstance(item["bmd_item"], str):
                raise TypeError("Could not get timeline item from DaVinci Script API")

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
            clips_to_process.append((clip_info_for_api, link_key))

    if not clips_to_process:
        return [], []

    # Sort and extract the clean list for the API
    clips_to_process.sort(key=lambda item_tuple: item_tuple[0].get("recordFrame", 0))
    final_clip_infos_for_api = [item_tuple[0] for item_tuple in clips_to_process]

    print(f"Appending {len(final_clip_infos_for_api)} clip segments...")
    appended_bmd_items: List[Any] = (
        media_pool.AppendToTimeline(final_clip_infos_for_api) or []
    )

    # Return the processed data and the API result for the wrapper to handle.
    return clips_to_process, appended_bmd_items


def append_and_link_timeline_items(create_new_timeline: bool = True) -> None:
    global MEDIA_POOL
    global TIMELINE
    global PROJECT

    project_data = globalz.PROJECT_DATA
    if not project_data or not project_data.get("timeline"):
        print("Error: Project data is missing or malformed.")
        return

    if not PROJECT:
        # Assuming PROJECT is accessible via globalz or another mechanism
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

    # === STEP 1: PRE-SCAN TO DETERMINE HIGHEST TRACK INDICES ===
    max_indices = {"video": 0, "audio": 0}
    for item in timeline_items:
        track_type = item.get("track_type")
        track_index = item["track_index"]
        if track_type in max_indices:
            max_indices[track_type] = max(max_indices[track_type], track_index)

    # === STEP 2: CREATE A NEW TIMELINE OR GET THE ACTIVE ONE ===
    timeline = None
    if create_new_timeline:
        print("Creating a new timeline...")
        timeline_name = f"linked_timeline_{uuid4().hex}"
        timeline = media_pool.CreateEmptyTimeline(timeline_name)
        if timeline:
            timeline.SetStartTimecode("00:00:00:00")
    else:
        timeline = TIMELINE
        if not timeline:
            return
        bmd_tl_items = [item["bmd_item"] for item in timeline_items]
        timeline.DeleteClips(bmd_tl_items)

    # Crucial check to ensure we have a valid timeline object to work with
    if not timeline:
        print("Error: Could not get a valid timeline. Aborting operation.")
        return

    for track_type, required_count in max_indices.items():
        current_count = timeline.GetTrackCount(track_type)
        tracks_to_add = required_count - current_count

        if tracks_to_add > 0:
            print(
                f"Timeline has {current_count} {track_type} track(s), adding {tracks_to_add} more..."
            )
            for _ in range(tracks_to_add):
                timeline.AddTrack(track_type)
        else:
            print(f"Timeline already has enough {track_type} tracks ({current_count}).")

    print(f"Operating on timeline: '{timeline.GetName()}'")
    TIMELINE = timeline

    success = False
    num_retries = 3
    sleep_time_between = 2.5
    for attempt in range(1, num_retries + 1):
        print("-" * 20)
        print(f"Attempt {attempt} of {num_retries}...")

        # The internal function returns our "source of truth" and the API's response
        processed_clips, bmd_items_from_api = _append_and_link(
            timeline, media_pool, timeline_items
        )

        if not processed_clips:
            success = True
            break

        # Use the list of clips we INTENDED to create for verification
        expected_clip_infos = [item[0] for item in processed_clips]
        if _verify_timeline_state(timeline, expected_clip_infos):
            print("Verification successful. Proceeding to link.")

            # === THE CORRECTED LINKING LOGIC ===

            # 1. Build a lookup map from the verified "source of truth"
            link_key_lookup: Dict[Tuple[int, int, int], Tuple[int, int]] = {}
            for clip_info, link_key in processed_clips:
                lookup_key = (
                    clip_info["mediaType"],
                    clip_info["trackIndex"],
                    clip_info["recordFrame"],
                )
                link_key_lookup[lookup_key] = link_key

            # 2. Get all clips that are actually on the timeline
            actual_items = []
            actual_items.extend(get_items_by_tracktype("video", timeline))
            actual_items.extend(get_items_by_tracktype("audio", timeline))

            # 3. Group the actual BMD objects using the lookup map
            link_groups: Dict[Tuple[int, int], List[Any]] = {}
            for item_dict in actual_items:
                media_type = 1 if item_dict["track_type"] == "video" else 2
                # Create the key for this actual clip
                actual_key = (
                    media_type,
                    item_dict["track_index"],
                    item_dict["start_frame"],
                )
                # Find its correct link_key from our map
                link_key = link_key_lookup.get(actual_key)

                if link_key:
                    if link_key not in link_groups:
                        link_groups[link_key] = []
                    # Append the actual BMD object to the correct group
                    link_groups[link_key].append(item_dict["bmd_item"])

            # 4. Perform the linking
            for group_key, clips_to_link in link_groups.items():
                if len(clips_to_link) >= 2:
                    print(
                        f"Linking {len(clips_to_link)} clips for group {group_key}..."
                    )
                    timeline.SetClipsLinked(clips_to_link, True)

            print("✅ Operation completed successfully.")
            success = True
            break
        else:
            print(f"Attempt {attempt} failed. Rolling back changes...")
            if bmd_items_from_api:
                timeline.DeleteClips(bmd_items_from_api, delete_gaps=False)

            if attempt < num_retries:
                print("Waiting a moment before retrying...")
                sleep(sleep_time_between)
                sleep_time_between += 1.5

    if not success:
        print("❌ Operation failed after all retries. Please check the logs.")


def _recursive_find_item_in_folder(
    current_folder: Any, item_id_to_find: str
) -> Optional[Any]:
    """
    Recursively scans a folder and its subfolders for an item with the given unique ID.

    Args:
        current_folder: The DaVinci Resolve Folder object to scan.
        item_id_to_find: The unique ID string of the MediaPoolItem to find.

    Returns:
        The Folder object containing the item if found, otherwise None.
    """
    if not current_folder:
        print("Warning: _recursive_find_item_in_folder received a None folder.")
        return None

    # 1. Check clips (items) in the current folder
    try:
        clips_in_folder = current_folder.GetClipList()
    except AttributeError:
        # This can happen if current_folder is not a valid Folder object (e.g., if GetRootFolder fails unexpectedly)
        print(
            f"Error: Could not get clip list from folder '{current_folder.GetName() if hasattr(current_folder, 'GetName') else 'Unknown Folder'}'."
        )
        return None

    for item in clips_in_folder:
        try:
            if item.GetUniqueId() == item_id_to_find:
                # print(f"Found item '{item_id_to_find}' in folder: {current_folder.GetName()}") # Optional
                return current_folder
        except AttributeError:
            # Item might not have GetUniqueId() if it's a malformed object, though unlikely for GetClipList() results
            print(
                f"Warning: An item in folder '{current_folder.GetName()}' does not have GetUniqueId method."
            )
            continue

    # 2. If not found, recurse into subfolders
    try:
        subfolders = current_folder.GetSubFolderList()
    except AttributeError:
        print(
            f"Error: Could not get subfolder list from folder '{current_folder.GetName() if hasattr(current_folder, 'GetName') else 'Unknown Folder'}'."
        )
        return None

    for subfolder in subfolders:
        found_folder = _recursive_find_item_in_folder(subfolder, item_id_to_find)
        if found_folder:
            return found_folder  # Propagate the result upwards
    return None


def find_item_folder_by_id(item_id: str) -> Any | None:
    """
    Finds the Media Pool Folder object that contains a MediaPoolItem (e.g., timeline, clip)
    with the specified unique ID. Scans recursively.

    Args:
        item_id: The unique ID string of the MediaPoolItem to find.

    Returns:
        The Folder object containing the item if found, otherwise None.
        Returns None if RESOLVE object is not available or no project is open.
    """
    global MEDIA_POOL
    if not MEDIA_POOL:
        return None
    root_folder = MEDIA_POOL.GetRootFolder()

    if not root_folder:
        print("Error: Could not get the root folder from the Media Pool.")
        return None

    print(
        f"Starting search for item ID '{item_id}' from root folder '{root_folder.GetName()}'."
    )
    return _recursive_find_item_in_folder(root_folder, item_id)


def signal_go_ready(go_server_port: int):
    """
    Sends an HTTP request to the Go server to signal readiness.
    Retries a few times in case the Go server isn't immediately available.
    """
    # This URL must match the endpoint defined in your Go server's LaunchHttpServer
    ready_url = f"http://localhost:{go_server_port}/ready"
    max_retries = 5
    retry_delay_seconds = 2

    print(f"Python Backend: Attempting to signal Go server at {ready_url}", flush=True)

    for attempt in range(max_retries):
        try:
            # Using GET, but POST would also work based on your Go handler
            response = requests.get(
                ready_url, timeout=10
            )  # 10-second timeout for the request
            response.raise_for_status()  # Raises an HTTPError for bad responses (4XX or 5XX)
            print(
                f"Python Backend: Successfully signaled Go server. Status: {response.status_code}",
                flush=True,
            )
            print(f"Python Backend: Go server response: {response.text}", flush=True)
            return True
        except requests.exceptions.RequestException as e:
            print(
                f"Python Backend: Error signaling Go (attempt {attempt + 1}/{max_retries}): {e}",
                flush=True,
            )
            if attempt < max_retries - 1:
                print(
                    f"Python Backend: Retrying in {retry_delay_seconds} seconds...",
                    flush=True,
                )
                sleep(retry_delay_seconds)
            else:
                print(
                    f"Python Backend: Failed to signal Go server after {max_retries} attempts.",
                    flush=True,
                )
                return False
    return False  # Should not be reached if max_retries > 0


class PythonCommandHandler(BaseHTTPRequestHandler):
    def _send_json_response(self, status_code, data_dict):
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data_dict).encode("utf-8"))

    def do_POST(self):
        if not self.path == "/command":
            self._send_json_response(
                404, {"status": "error", "message": "Endpoint not found."}
            )

        if ENABLE_COMMAND_AUTH:
            auth_header = self.headers.get("Authorization")
            token_valid = False
            if auth_header and auth_header.startswith("Bearer ") and AUTH_TOKEN:
                received_token = auth_header.split(" ")[1]
                if received_token == AUTH_TOKEN:
                    token_valid = True

            if not token_valid:
                print(
                    "Python Command Server: Unauthorized command attempt from Go.",
                    flush=True,
                )
                self._send_json_response(
                    401, {"status": "error", "message": "Unauthorized"}
                )
                return
            print(
                "Python Command Server: Go authenticated successfully for command.",
                flush=True,
            )
        else:
            print(
                "Python Command Server: Command authentication is currently disabled.",
                flush=True,
            )

        content_length = int(self.headers["Content-Length"])
        post_data_bytes = self.rfile.read(content_length)
        try:
            data = json.loads(post_data_bytes.decode("utf-8"))
            command = data.get("command")
            params = data.get("params", {})

            task_id = params.get("taskId")
            callback_url = data.get("callbackUrl")

            truncated_params: str = ""
            if len(str(params)) > 100:
                truncated_params = str(params)[:100] + "..."
            else:
                truncated_params = str(params)

            print(
                f"Python Command Server: Received command '{command}' with params: {truncated_params}",
                flush=True,
            )

            response_payload = {}
            # --- Implement your command handlers here ---
            if command == "sync":
                response_payload = {"status": "success", "message": "Command received."}
                self._send_json_response(200, response_payload)
                main(sync=True, task_id=task_id)
                return
            elif command == "makeFinalTimeline":
                project_data_from_go = params.get("projectData")
                # turn project_data_from_go into a ProjectData object
                project_data_from_go = ProjectData(**project_data_from_go)
                response_payload = {
                    "status": "success",
                    "message": "Final timeline generation started.",
                }
                self._send_json_response(200, response_payload)
                # merge_project_data(project_data_from_go)
                deep_merge_bmd_aware(globalz.PROJECT_DATA, project_data_from_go)

                # save project data to json for debugging
                debug_output_path = os.path.join(
                    os.path.dirname(TEMP_DIR), "project_data_from_go.json"
                )
                misc_utils.export_to_json(globalz.PROJECT_DATA, debug_output_path)

                main(sync=False, task_id=task_id)
                return

            elif command == "saveProject":
                print("Python: Simulating project save...", flush=True)
                response_payload = {
                    "status": "success",
                    "message": "Project save command received.",
                }
            elif command == "setPlayhead":
                time_value = params.get(
                    "time"
                )  # e.g., {"time": "01:00:10:00"} or {"time": 70.5}
                if time_value is not None:
                    print(
                        f"Python: Simulating set playhead to {time_value}...",
                        flush=True,
                    )
                    response_payload = {
                        "status": "success",
                        "message": f"Playhead position set to {time_value}.",
                    }
                else:
                    self._send_json_response(
                        400,
                        {
                            "status": "error",
                            "message": "Missing 'time' parameter for setPlayhead.",
                        },
                    )
                    return
            else:
                self._send_json_response(
                    400, {"status": "error", "message": f"Unknown command: {command}"}
                )
                return

            self._send_json_response(200, response_payload)

        except json.JSONDecodeError:
            print("Python Command Server: Invalid JSON received from Go.", flush=True)
            self._send_json_response(
                400,
                {"status": "error", "message": "Invalid JSON format in request body."},
            )
        except Exception as e:
            print(
                f"Python Command Server: Error processing command '{command}': {e}",
                flush=True,
            )
            full_trace = traceback.format_exc()
            print(full_trace)
            self._send_json_response(
                500, {"status": "error", "message": f"Internal error: {str(e)}"}
            )


def run_python_command_server(listen_port: int):
    server_address = ("localhost", listen_port)
    httpd = HTTPServer(server_address, PythonCommandHandler)
    print(
        f"Python Command Server: Listening for Go commands on localhost:{listen_port}...",
        flush=True,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Python Command Server: Shutting down.", flush=True)
    httpd.server_close()


def init():
    global GO_SERVER_PORT
    global RESOLVE

    parser = argparse.ArgumentParser()
    parser.add_argument("-threshold", type=float)
    parser.add_argument(
        "-gp", "--go-port", type=int
    )  # port to communicate with http server
    parser.add_argument(
        "-lp", "--listen-on-port", type=int
    )  # port to receive commands from go
    parser.add_argument("--auth-token", type=str)  # authorization token
    parser.add_argument("-min_duration", type=float)
    parser.add_argument("-padding_l", type=float)
    parser.add_argument("-padding_r", type=float)
    parser.add_argument("-s", "--sync", action="store_true")
    parser.add_argument("--standalone", action="store_true")
    args = parser.parse_args()

    GO_SERVER_PORT = args.go_port

    # --- FUTURE: Store shared secret ---
    # global EXPECTED_GO_COMMAND_TOKEN, ENABLE_COMMAND_AUTH
    # if args.auth-token:
    #     EXPECTED_GO_COMMAND_TOKEN = args.auth-token
    #     ENABLE_COMMAND_AUTH = True # Or make this a separate flag
    #     print(f"Python Command Server: Will expect Go to authenticate commands with the shared secret.", flush=True)

    print(f"Python Backend: Go's server port: {args.go_port}", flush=True)
    print(
        f"Python Backend: Will listen for commands on port: {args.listen_on_port}",
        flush=True,
    )

    if args.standalone:
        global STANDALONE_MODE
        STANDALONE_MODE = True
        main()
        return

    # Start Python's own HTTP server (for Go commands) in a separate thread
    command_server_thread = threading.Thread(
        target=run_python_command_server, args=(args.listen_on_port,), daemon=True
    )
    command_server_thread.start()

    # Perform other Python initializations...
    print("Python Backend: Internal initialization complete.", flush=True)

    if not signal_go_ready(args.go_port):
        print(
            "Python Backend: CRITICAL - Could not signal main readiness to Go application.",
            flush=True,
        )
        # Consider how to handle this - maybe try to stop the command_server_thread or sys.exit(1)
    else:
        print(
            "Python Backend: Successfully signaled main readiness to Go application.",
            flush=True,
        )

    print(
        "Python Backend: Running. Command server is active in a background thread.",
        flush=True,
    )
    try:
        command_server_thread.join()  # Keep main thread alive while server thread is running
    except KeyboardInterrupt:
        print("Python Backend: Main thread interrupted. Shutting down.", flush=True)

    print("Python Backend: Exiting.", flush=True)

    sys.exit(1)


if __name__ == "__main__":
    script_time = time()

    init()

    # main(sync=args.sync)
    # script_end_time = time()
    # script_execution_time = script_end_time - script_time
    # print(f"Script finished successfully in {script_execution_time:.2f} seconds.")
