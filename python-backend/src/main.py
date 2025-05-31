#!/usr/bin/env python3

from __future__ import annotations
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
    TypedDict,
    Union,
)
import os
import sys
import subprocess
import argparse

from concurrent.futures import ThreadPoolExecutor, as_completed

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

import create_otio

from project_orga import (
    map_media_pool_items_to_folders,
    MediaPoolItemFolderMapping,
    move_clips_to_temp_folder,
    restore_clips_from_temp_folder,
)

import requests
from http.server import HTTPServer, BaseHTTPRequestHandler


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


def extract_audio(file: Any, target_folder: str) -> AudioFromVideo | None:
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
        "silencedetect=n=-20dB:d=0.5",
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


def get_resolve() -> Any:
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
        print(f"Failed to import GetResolve or its dependencies: {e}")
        print("Check and ensure DaVinci Resolve installation is correct.")
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred during import: {e}")
        sys.exit(1)
    resolve = GetResolve()  # noqa
    return resolve


# GLOBALS
RESOLVE = get_resolve()
TEMP_DIR: str = os.path.join(os.path.dirname(__file__), "..", "wav_files")
TEMP_DIR = os.path.abspath(TEMP_DIR)
if not os.path.exists(TEMP_DIR):
    os.makedirs(TEMP_DIR)

# This will be the token Go sends, which Python expects for Go-to-Python commands (future)
AUTH_TOKEN = None
ENABLE_COMMAND_AUTH = False # Master switch for auth on Python's command server
GO_SERVER_PORT = 0

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
            start_frame = item.GetStart()
            item_name = item.GetName()
            media_pool_item = item.GetMediaPoolItem()
            source_file_path: str = media_pool_item.GetClipProperty("File Path") if media_pool_item else ""
            timeline_item: TimelineItem = {
                "bmd_item": item,
                "duration": 0,  # unused, therefore 0 #item.GetDuration(),
                "name": item_name,
                "edit_instructions": [],
                "start_frame": start_frame,
                "end_frame": item.GetEnd(),
                "id": get_item_id(item, item_name, start_frame, track_type, i),
                "track_type": track_type,
                "track_index": i,
                "source_file_path": source_file_path,
                "processed_file_name": misc_utils.uuid_from_path(source_file_path).hex,
                "source_start_frame": item.GetSourceStartFrame(),
                "source_end_frame": item.GetSourceEndFrame(),
            }
            items.append(timeline_item)
    return items


def get_source_media_from_timeline_item(
    timeline_item: TimelineItem,
) -> Union[FileSource, None]:
    media_pool_item = timeline_item["bmd_item"].GetMediaPoolItem()
    if not media_pool_item:
        return None
    filepath = media_pool_item.GetClipProperty("File Path")
    if not filepath:
        print(f"Audio mapping: {media_pool_item.GetAudioMapping()}")
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
    

def main(sync: bool = False) -> Optional[bool]:
    global RESOLVE
    global TEMP_DIR
    script_start_time: float = time()
    if not RESOLVE and not resync_with_resolve():
        message = "Could not connect to DaVinci Resolve. Is it running?"
        send_message_to_go(
        "showAlert",
        {
            "title": "DaVinci Resolve Error",
            "message": message,
            "severity": "error"
        }
        )
        return False

    #switch_to_page("edit")
    project = RESOLVE.GetProjectManager().GetCurrentProject()
    if not project:
        message = "Please open a project and open a timeline."
        send_message_to_go(
        "showAlert",
        {
            "title": "No open Project",
            "message": message,
            "severity": "error"
        }
        )
        return False

    timeline = project.GetCurrentTimeline()
    if not timeline:
        message = "Please make sure you opened a timeline."
        send_message_to_go(
        "showAlert",
        {
            "title": "No open timeline",
            "message": message,
            "severity": "error"
        }
        )
        return False

    timeline_name = timeline.GetName()
    timeline_fps = timeline.GetSetting("timelineFrameRate")
    current_file_path = os.path.dirname(os.path.abspath(__file__))
    # export state of current timeline to otio
    input_otio_path = os.path.join(TEMP_DIR, f"pre-edit_timeline_export.otio")
    export_timeline_to_otio(timeline, file_path=input_otio_path)
    print(f"Exported timeline to OTIO in {input_otio_path}")

    video_track_items: list[TimelineItem] = get_items_by_tracktype("video", timeline)
    audio_track_items: list[TimelineItem] = get_items_by_tracktype("audio", timeline)

    tl_dict: Timeline = {
        "name": timeline_name,
        "fps": timeline_fps,
        "video_track_items": video_track_items,
        "audio_track_items": audio_track_items,
    }

    # Final structure:
    project_data: ProjectData = {
        "project_name": project.GetName(),
        "timeline": tl_dict,
        "files": {},
    }

    seen_uuids: list[str] = []
    audio_source_files: list[FileSource] = [] # includes duplicates (true to timeline)
    audio_sources_set: list[FileSource] = [] # no duplicates
    for item in audio_track_items:
        source_media_item = get_source_media_from_timeline_item(item)
        if not source_media_item:
            continue
        audio_source_files.append(source_media_item)
        if source_media_item["uuid"] in seen_uuids:
            continue
        seen_uuids.append(source_media_item["uuid"])
        audio_sources_set.append(source_media_item)

    if len(audio_source_files) == 0:
        print("No file paths to process.")
        sys.exit(1)

    print(f"Source media files count: {len(audio_source_files)}")
    silence_detect_time_start = time()

    processed_audio_paths: list[AudioFromVideo] = process_audio_files(
        audio_sources_set, TEMP_DIR
    )
    silence_intervals_by_file = detect_silence_parallel(
        processed_audio_paths, timeline_fps
    )

    for file in audio_source_files:
        audio_path = file["file_path"]
        project_data["files"][audio_path] = {
            "properties": {
                "FPS": timeline_fps,
            },
            "silenceDetections": [],
            "timelineItems": [],
            "fileSource": file,
        }
        if audio_path not in silence_intervals_by_file:
            print(f"No silence detected in {audio_path}")
            continue

        silence_intervals: AudioFromVideo = silence_intervals_by_file[audio_path]

        project_data["files"][audio_path]["silenceDetections"] = silence_intervals[
            "silence_intervals"
        ]
        print(f"Detected {len(silence_intervals)} silence segments in {audio_path}")

    end_time_silence = time()
    execution_time_silence = end_time_silence - silence_detect_time_start

    start_calc_edits = time()
    for item in project_data["timeline"]["audio_track_items"]:
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
        timeline_items: list[TimelineItem] = project_data["files"][clip_file_path][
            "timelineItems"
        ]

        silence_detections: Union[List[SilenceInterval], None] = project_data["files"][
            clip_file_path
        ]["silenceDetections"]
        if silence_detections:
            edit_instructions: List[EditInstruction] = (
                create_edits_with_optional_silence(main_clip_data, silence_detections)
            )
            item["edit_instructions"] = edit_instructions
            timeline_items.append(item)
    print(f"It took {time() - start_calc_edits:.2f} seconds to calculate edits")

    json_ex_start = time()
    json_output_path = os.path.join(TEMP_DIR, "silence_detections.json")
    misc_utils.export_to_json(project_data, json_output_path)
    print(f"it took {time() - json_ex_start:.2f} seconds to export to JSON")

    if sync:
        print("just syncing, exiting")
        print(f"it took {time() - script_start_time:.2f} seconds for script to finish")
        send_message_to_go(message_type="projectData", payload=project_data)
        return

    edited_otio_path = os.path.join(TEMP_DIR, "edited_timeline_refactored.otio")
    create_otio.edit_timeline_with_precalculated_instructions(
        input_otio_path, project_data, edited_otio_path
    )

    original_item_folder_map: dict[str, MediaPoolItemFolderMapping] = (
        map_media_pool_items_to_folders(project, project_data)
    )

    media_pool = project.GetMediaPool()
    timeline_id = timeline.GetMediaPoolItem().GetUniqueId()
    original_timeline_folder = find_item_folder_by_id(project, timeline_id)
    original_folder = media_pool.GetCurrentFolder()

    start_move_clips = time()
    # sleep(5.1)
    temp_folder = move_clips_to_temp_folder(
        project=project,
        item_folder_map=original_item_folder_map,
        temp_folder_name=str(time()),
    )
    end_move_clips = time()
    print(
        f"Moving clips to temp folder took {end_move_clips - start_move_clips:.2f} seconds"
    )
    # make sure the current folder is the temp folder
    # media_pool.SetCurrentFolder(temp_folder)

    ## OTIO TIMELINE IMPORT
    start_import = time()
    timeline_name = f"{timeline_name} - Silence Detection{time()}"
    timeline = media_pool.ImportTimelineFromFile(
        edited_otio_path,
        {
            "timelineName": timeline_name,
            "importSourceClips": True,
        },
    )
    if not timeline:
        print("Failed to import OTIO timeline.")
        return
    timeline_media_id = timeline.GetMediaPoolItem().GetMediaId()

    print(f"Imported OTIO timeline: {timeline.GetName()}")
    # sleep(2.0)
    end_import = time()
    print(f"Importing OTIO took {end_import - start_import:.2f} seconds")

    start_restore_clips = time()

    # move the edited timeline to the "current folder"
    if original_timeline_folder:
        timeline_mapping_item: MediaPoolItemFolderMapping = {
            "bmd_folder": original_timeline_folder,
            "bmd_media_pool_item": timeline.GetMediaPoolItem(),
            "media_pool_name": timeline.GetName(),
            "file_path": "",
        }
        print(f"Timeline mapping item: {timeline_mapping_item}")
        print(f"Timeline media ID: {timeline_media_id}")

        original_item_folder_map[timeline_media_id] = timeline_mapping_item

        # # this can be optimized by adding it to item_folder_map (one api call less)
        # edited_moved = media_pool.MoveClips(
        #     [timeline.GetMediaPoolItem()], original_timeline_folder
        # )
        # print(edited_moved)

    restore_clips_from_temp_folder(project, original_item_folder_map, temp_folder)
    media_pool.SetCurrentFolder(original_timeline_folder)
    end_restore_clips = time()
    print(
        f"Restoring clips from temp folder took {end_restore_clips - start_restore_clips:.2f} seconds"
    )

    # set the folder back to the original
    if original_folder:
        media_pool.SetCurrentFolder(original_folder)
        print(f"Switched back to folder: {original_folder.GetName()}")

    return

    full_end_time = time()
    execution_time = full_end_time - script_start_time
    print(f"Script finished successfully in {execution_time:.2f} seconds.")

    time_edit_start = time()
    make_edit_timeline(project_data, project)
    time_edit_end = time()
    time_to_edit = time_edit_end - time_edit_start
    print(f"Silence detection completed in {execution_time_silence:.2f} seconds.")
    print(f"Edit timeline creation completed in {time_to_edit:.2f} seconds.")
    export_otio_start = time()
    edit_timeline = project.GetCurrentTimeline()
    input_otio_path = os.path.join(current_file_path, f"temp_timeline_export2.otio")
    export_timeline_to_otio(edit_timeline, file_path=input_otio_path)
    export_otio_endtime = time()
    export_otio_exec_time = export_otio_endtime - export_otio_start
    print(
        f"Exported timeline to XML in {export_otio_exec_time:.2f} seconds. File path: {input_otio_path}"
    )


def get_item_id(
    item: Any, item_name: str, start_frame: float, track_type: str, track_index: int
) -> str:
    return f"{item_name}-{track_type}-{track_index}--{start_frame}"


def make_edit_timeline(project_data: ProjectData, project) -> None:
    global RESOLVE
    curr_timecode = project.GetCurrentTimeline().GetCurrentTimecode()

    # make a new timeline
    tl_name = project_data["timeline"]["name"]
    tl_fps = project_data["timeline"]["fps"]

    edit_timeline_name = f"{tl_name} - Silence Detection"
    media_pool = project.GetMediaPool()
    edit_timeline = media_pool.CreateEmptyTimeline(edit_timeline_name)

    num = 1
    while not edit_timeline:
        edit_timeline_name = f"{tl_name} - Silence Detection_{num}"
        edit_timeline = media_pool.CreateEmptyTimeline(edit_timeline_name)
        num += 1

    # switch_to_page("edit")
    project.SetCurrentTimeline(edit_timeline)

    media_appends: list[Any] = []
    media_pool = project.GetMediaPool()
    media_pool_items = []
    timeline_items: list[TimelineItem] = []
    for item in project_data["timeline"]["audio_track_items"]:
        media_pool_item = item["bmd_item"].GetMediaPoolItem()
        if not media_pool_item:
            print("skip")
            continue
        media_pool_items.append(media_pool_item)
        timeline_items.append(item)

    for item in project_data["timeline"]["video_track_items"]:
        media_pool_item = item["bmd_item"].GetMediaPoolItem()
        if not media_pool_item:
            continue
        media_pool_items.append(media_pool_item)
        timeline_items.append(item)

    FLOAT_EPSILON = 1e-9
    for timeline_item in timeline_items:
        current_media_pool_item = timeline_item["bmd_item"].GetMediaPoolItem()

        edit_instructions = timeline_item["edit_instructions"]

        for edit in edit_instructions:
            timeline_start_frame = edit["start_frame"]
            source_start_time = edit["source_start_frame"]
            source_end_time_inclusive = edit["source_end_frame"]

            # Adjust source end frame assuming API expects exclusive end (+1 frame concept)
            source_end_exclusive = source_end_time_inclusive + 1.0

            # Safety check using original inclusive source values
            if source_end_time_inclusive <= source_start_time + FLOAT_EPSILON:
                # Optional: assert error
                raise ValueError(
                    f"Source end frame {source_end_time_inclusive} is not greater than start frame {source_start_time}"
                )

            clip_info = {
                "mediaPoolItem": current_media_pool_item,
                "startFrame": source_start_time,
                "endFrame": source_end_exclusive,  # Using adjusted exclusive end
                "recordFrame": timeline_start_frame,
                # Ensure mediaType is set correctly based on 'edit["enabled"]' and API requirements
                # "mediaType": None,
                # Add trackIndex etc. if needed
            }
            media_appends.append(clip_info)

    # list append
    # append = media_pool.AppendToTimeline(media_appends)
    # print(f"Total cuts made: {len(append)}")

    # single appends
    for item in media_appends:
        append = media_pool.AppendToTimeline([item])

    # apply the timecode to the timeline
    print(f"Setting timeline timecode to {curr_timecode}")
    print(f"Timeline timecode: {edit_timeline.GetCurrentTimecode()}")
    edit_timeline.SetCurrentTimecode(curr_timecode)
    print(f"Timeline timecode after: {edit_timeline.GetCurrentTimecode()}")


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
        print(f"Warning: _recursive_find_item_in_folder received a None folder.")
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


def find_item_folder_by_id(project, item_id: str) -> Any | None:
    """
    Finds the Media Pool Folder object that contains a MediaPoolItem (e.g., timeline, clip)
    with the specified unique ID. Scans recursively.

    Args:
        item_id: The unique ID string of the MediaPoolItem to find.

    Returns:
        The Folder object containing the item if found, otherwise None.
        Returns None if RESOLVE object is not available or no project is open.
    """
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()

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
            response = requests.get(ready_url, timeout=10)  # 10-second timeout for the request
            response.raise_for_status()  # Raises an HTTPError for bad responses (4XX or 5XX)
            print(f"Python Backend: Successfully signaled Go server. Status: {response.status_code}", flush=True)
            print(f"Python Backend: Go server response: {response.text}", flush=True)
            return True
        except requests.exceptions.RequestException as e:
            print(f"Python Backend: Error signaling Go (attempt {attempt + 1}/{max_retries}): {e}", flush=True)
            if attempt < max_retries - 1:
                print(f"Python Backend: Retrying in {retry_delay_seconds} seconds...", flush=True)
                sleep(retry_delay_seconds)
            else:
                print(f"Python Backend: Failed to signal Go server after {max_retries} attempts.", flush=True)
                return False
    return False # Should not be reached if max_retries > 0


class PythonCommandHandler(BaseHTTPRequestHandler):
    def _send_json_response(self, status_code, data_dict):
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data_dict).encode('utf-8'))

    def do_POST(self):
        if not self.path == '/command':
            self._send_json_response(404, {"status": "error", "message": "Endpoint not found."})
        
        if ENABLE_COMMAND_AUTH:
            auth_header = self.headers.get('Authorization')
            token_valid = False
            if auth_header and auth_header.startswith('Bearer ') and AUTH_TOKEN:
                received_token = auth_header.split(' ')[1]
                if received_token == AUTH_TOKEN:
                    token_valid = True
        
            if not token_valid:
                print("Python Command Server: Unauthorized command attempt from Go.", flush=True)
                self._send_json_response(401, {"status": "error", "message": "Unauthorized"})
                return
            print("Python Command Server: Go authenticated successfully for command.", flush=True)
        else:
            print("Python Command Server: Command authentication is currently disabled.", flush=True)

        content_length = int(self.headers['Content-Length'])
        post_data_bytes = self.rfile.read(content_length)
        try:
            data = json.loads(post_data_bytes.decode('utf-8'))
            command = data.get('command')
            params = data.get('params', {})

            print(f"Python Command Server: Received command '{command}' with params: {params}", flush=True)
            
            response_payload = {}
            # --- Implement your command handlers here ---
            if command == 'sync':
                response_payload = {"status": "success", "message": "Command received."}
                self._send_json_response(200, response_payload)
                main(sync=True)
                return
            elif command == 'makeFinalTimeline':
                print("Python: Simulating final timeline generation...", flush=True)
                response_payload = {"status": "success", "message": "Final timeline generation started."}
            elif command == 'saveProject':
                print("Python: Simulating project save...", flush=True)
                response_payload = {"status": "success", "message": "Project save command received."}
            elif command == 'setPlayhead':
                time_value = params.get('time') # e.g., {"time": "01:00:10:00"} or {"time": 70.5}
                if time_value is not None:
                    print(f"Python: Simulating set playhead to {time_value}...", flush=True)
                    response_payload = {"status": "success", "message": f"Playhead position set to {time_value}."}
                else:
                    self._send_json_response(400, {"status": "error", "message": "Missing 'time' parameter for setPlayhead."})
                    return
            else:
                self._send_json_response(400, {"status": "error", "message": f"Unknown command: {command}"})
                return
            
            self._send_json_response(200, response_payload)

        except json.JSONDecodeError:
            print("Python Command Server: Invalid JSON received from Go.", flush=True)
            self._send_json_response(400, {"status": "error", "message": "Invalid JSON format in request body."})
        except Exception as e:
            print(f"Python Command Server: Error processing command '{command}': {e}", flush=True)
            full_trace = traceback.format_exc()
            print(full_trace)
            self._send_json_response(500, {"status": "error", "message": f"Internal server error: {str(e)}"})

def run_python_command_server(listen_port: int):
    server_address = ('localhost', listen_port)
    httpd = HTTPServer(server_address, PythonCommandHandler)
    print(f"Python Command Server: Listening for Go commands on localhost:{listen_port}...", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Python Command Server: Shutting down.", flush=True)
    httpd.server_close()


def send_message_to_go(message_type: str, payload: Any):
    global GO_SERVER_PORT
    if GO_SERVER_PORT == 0:
        print("Python Error: Go server port not configured. Cannot send message to Go.", flush=True)
        return False
    
    url = f"http://localhost:{GO_SERVER_PORT}/msg" # Your Go endpoint for general messages
    
    message_data = {
        "type": message_type,
        "payload": payload
    }
    try:
        headers = {"Content-Type": "application/json"}
        # This is an independent HTTP request from Python to Go
        def fallback_serializer(obj):
            return "<BMDObject>"
        
        response = requests.post(url, data=json.dumps(message_data, default=fallback_serializer), headers=headers, timeout=5) # 5s timeout
        response.raise_for_status()
        print(f"Python (to Go): Message type '{message_type}' sent. Go responded: {response.status_code}", flush=True)
        return True
    except requests.exceptions.RequestException as e:
        print(f"Python (to Go): Error sending message type '{message_type}': {e}", flush=True)
        print(f"Payload: {payload}")
        return False


def init():
    global GO_SERVER_PORT
    parser = argparse.ArgumentParser()
    parser.add_argument('-threshold', type=float)
    parser.add_argument('-gp', '--go-port', type=int) # port to communicate with http server
    parser.add_argument('-lp', '--listen-on-port', type=int) # port to receive commands from go
    parser.add_argument('--auth-token', type=str) # authorization token
    parser.add_argument('-min_duration', type=float)
    parser.add_argument('-padding_l', type=float)
    parser.add_argument('-padding_r', type=float)
    parser.add_argument('-s', '--sync', action='store_true')
    args = parser.parse_args()

    GO_SERVER_PORT = args.go_port
    
   # --- FUTURE: Store shared secret ---
    # global EXPECTED_GO_COMMAND_TOKEN, ENABLE_COMMAND_AUTH
    # if args.auth-token:
    #     EXPECTED_GO_COMMAND_TOKEN = args.auth-token
    #     ENABLE_COMMAND_AUTH = True # Or make this a separate flag
    #     print(f"Python Command Server: Will expect Go to authenticate commands with the shared secret.", flush=True)

    print(f"Python Backend: Go's server port: {args.go_port}", flush=True)
    print(f"Python Backend: Will listen for commands on port: {args.listen_on_port}", flush=True)


    # Start Python's own HTTP server (for Go commands) in a separate thread
    command_server_thread = threading.Thread(target=run_python_command_server, args=(args.listen_on_port,), daemon=True)
    command_server_thread.start()

    # Perform other Python initializations...
    print("Python Backend: Internal initialization complete.", flush=True)

    # Signal to Go that Python (including its command server) is ready
    if not signal_go_ready(args.go_port):
        print("Python Backend: CRITICAL - Could not signal main readiness to Go application.", flush=True)
        # Consider how to handle this - maybe try to stop the command_server_thread or sys.exit(1)
    else:
        print("Python Backend: Successfully signaled main readiness to Go application.", flush=True)
    
    print("Python Backend: Running. Command server is active in a background thread.", flush=True)
    try:
        command_server_thread.join() # Keep main thread alive while server thread is running
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
