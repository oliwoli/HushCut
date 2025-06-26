#!/usr/bin/env python3

from __future__ import annotations
from collections import Counter
from collections.abc import Mapping
import json
import http

import pprint
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
import atexit
from uuid import uuid4
import uuid

from edit_silence import (
    create_edits_with_optional_silence,
    ClipData,
    SilenceInterval,
    EditInstruction,
)

import misc_utils

from local_types import (
    NestedAudioTimelineItem,
    Timeline,
    TimelineItem,
    FileSource,
    ProjectData,
    AudioFromVideo,
)

import globalz

from otio_as_bridge import (
    unify_linked_items_in_project_data,
    populate_nested_clips,
    unify_edit_instructions,
)

# from project_orga import (
#     map_media_pool_items_to_folders,
#     MediaPoolItemFolderMapping,
#     move_clips_to_temp_folder,
#     restore_clips_from_temp_folder,
# )


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
FFMPEG = "ffmpeg"
MAKE_NEW_TIMELINE = True


class ProgressTracker:
    def __init__(self):
        """
        Initializes the tracker and a background thread pool for sending updates.
        """
        self.task_id = ""
        self._tasks = {}
        self._total_weight = 0.0
        self._task_progress = {}
        self._last_report = time()

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

    def _report_progress(self, message: str):
        """
        Submits the send_progress_update function to the thread pool
        to be executed in the background.
        """
        # 3. Instead of calling the function directly, submit it to the executor.
        #    The main thread will not wait for this to complete.
        if time() - self._last_report > 0.25:
            self._executor.submit(
                send_progress_update, self.task_id, self.get_percentage(), message
            )
            self._last_report = time()

    # --- No changes needed for the methods below ---

    def update_task_progress(
        self, task_name: str, percentage: float, message: str = ""
    ):
        # ... (logic is identical)
        if not self.task_id:
            print("Warning: Tracker not initialized. Call start_new_run() first.")
            return
        if task_name not in self._tasks:
            print(f"Warning: Task '{task_name}' not found.")
            return
        percentage = max(0, min(100, percentage))
        self._task_progress[task_name] = self._tasks[task_name] * (percentage / 100.0)
        update_message = message if message is not None else task_name
        print(
            f"Updating '{task_name}' to {percentage:.1f}%. Overall: {self.get_percentage():.2f}%"
        )
        self._report_progress(update_message)

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
    global STANDALONE_MODE
    if STANDALONE_MODE:
        return

    global GO_SERVER_PORT
    if GO_SERVER_PORT == 0:
        print(
            "Python Error: Go server port not configured. Cannot send message to Go.",
            flush=True,
        )
        return False

    # Use http.client for sending messages to Go
    conn = None
    try:
        conn = http.client.HTTPConnection("localhost", GO_SERVER_PORT, timeout=5)
        headers = {"Content-Type": "application/json"}

        # Helper to serialize objects that might not be directly JSON serializable
        def fallback_serializer(obj):
            if hasattr(obj, "__dict__"):
                return obj.__dict__
            return str(obj) # Fallback to string representation

        # Construct the message as expected by the Go backend
        go_message = {
            "Type": message_type,
            "Payload": payload
        }
        json_payload = json.dumps(go_message, default=fallback_serializer)
        
        path = f"/msg?task_id={task_id}" if task_id else "/msg"
        conn.request("POST", path, body=json_payload, headers=headers)
        response = conn.getresponse()

        if response.status >= 200 and response.status < 300:
            print(
                f"Python (to Go): Message type '{message_type}' sent. Task id: {task_id}. Go responded: {response.status}",
                flush=True,
            )
            return True
        else:
            print(
                f"Python (to Go): Error sending message type '{message_type}'. Go responded with status {response.status}: {response.read().decode()}",
                flush=True,
            )
            return False
    except http.client.HTTPException as e:
        print(
            f"Python (to Go): HTTP error sending message type '{message_type}': {e}",
            flush=True,
        )
        return False
    except Exception as e:
        print(
            f"Python (to Go): General error sending message type '{message_type}': {e}",
            flush=True,
        )
        return False
    finally:
        if conn:
            conn.close()


def resolve_import_error_msg(e: Exception, task_id: str = "") -> None:
    global STANDALONE_MODE

    print(f"Failed to import GetResolve: {e}")
    print("Check and ensure DaVinci Resolve installation is correct.")

    if not STANDALONE_MODE:
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
    global RESOLVE
    if not timeline:
        print("No timeline to export.")
        return

    if not RESOLVE:
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
    global RESOLVE

    if not RESOLVE:
        return

    if not timeline:
        print("No timeline to export.")
        return

    # Assuming the Resolve API has a method to export timelines
    success = timeline.Export(file_path, RESOLVE.EXPORT_OTIO)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


def extract_audio(file: FileSource, target_folder: str) -> Optional[AudioFromVideo]:
    global FFMPEG
    filepath = file.get("file_path")
    if not filepath or not os.path.exists(filepath):
        return

    wav_path = os.path.join(target_folder, f"{file['uuid']}.wav")

    # This object is created regardless, as it's needed for the return value
    audio_from_video: AudioFromVideo = {
        "audio_file_name": os.path.basename(wav_path),
        "audio_file_path": wav_path,
        "audio_file_uuid": file["uuid"],
        "video_file_path": filepath,
        "video_bmd_media_pool_item": file["bmd_media_pool_item"],
        "silence_intervals": [],
    }

    # The caller now determines if this function is needed.
    # The check remains here as a safeguard.
    if misc_utils.is_valid_audio(wav_path):
        return audio_from_video

    print(f"Extracting audio from: {filepath}")
    audio_extract_cmd = [
        FFMPEG,
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

    # Final check to ensure extraction was successful
    if misc_utils.is_valid_audio(wav_path):
        return audio_from_video
    else:
        print(f"Error: Failed to extract or validate audio for {filepath}")
        return None


def process_audio_files(
    audio_source_files: list[FileSource], target_folder: str, max_workers=4
) -> list[AudioFromVideo]:
    """Runs audio extraction in parallel using ThreadPoolExecutor."""
    start_time = time()
    audios_from_video: list[AudioFromVideo] = []

    if not audio_source_files:
        return []

    print(
        f"Starting audio extraction for {len(audio_source_files)} files with {max_workers} workers."
    )
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(extract_audio, file, target_folder)
            for file in audio_source_files
        ]

        for future in as_completed(futures):
            result = future.result()
            if result:  # Only add valid results
                audios_from_video.append(result)

    print(
        f"Audio extraction for {len(audio_source_files)} files completed in {time() - start_time:.2f} seconds."
    )
    return audios_from_video


def detect_silence_in_file(audio_file: AudioFromVideo, timeline_fps) -> AudioFromVideo:
    """Runs FFmpeg silence detection on a single WAV file and returns intervals."""
    global FFMPEG
    processed_audio = audio_file["audio_file_path"]
    silence_detect_cmd = [
        FFMPEG,
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

    if not processed_audio:
        return {}

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
                "duration": 0,  # unused, therefore 0 #item.GetDuration(),
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
    fps: float,
    curr_processed_file_names: list[str],
):
    """
    Finds unique compound/multicam content on the timeline, and for each,
    either renders a mixdown (standalone mode) or prepares the data for Go.
    """
    global FFMPEG, TEMP_DIR, STANDALONE_MODE

    # --- Pass 1: Map all compound/multicam clips by their content UUID ---
    content_map = {}
    for item in audio_timeline_items:
        if not item.get("type") or not item.get("nested_clips"):
            continue

        content_uuid = generate_uuid_from_nested_clips(item, item["nested_clips"])
        if content_uuid not in content_map:
            content_map[content_uuid] = []
        content_map[content_uuid].append(item)

    # --- Pass 2: Process each unique content group ---
    for content_uuid, items_in_group in content_map.items():
        representative_item = items_in_group[0]
        output_filename = f"{content_uuid}.wav"
        output_wav_path = os.path.join(TEMP_DIR, output_filename)

        needs_render = f"{content_uuid}.wav" not in curr_processed_file_names

        if needs_render and STANDALONE_MODE:
            print(f"Standalone Mode: Rendering mixdown for content ID {content_uuid}")
            nested_clips = representative_item["nested_clips"]
            unique_source_files = list(
                set([nc["source_file_path"] for nc in nested_clips])
            )
            source_map = {path: i for i, path in enumerate(unique_source_files)}

            filter_complex_parts = []
            delayed_streams = []

            for i, nested_clip in enumerate(nested_clips):
                source_index = source_map[nested_clip["source_file_path"]]
                start_sec = nested_clip["source_start_frame"] / fps
                duration_sec = nested_clip["duration"] / fps
                trim_filter = f"[{source_index}:a]atrim=start={start_sec}:duration={duration_sec},asetpts=PTS-STARTPTS[t{i}];"
                filter_complex_parts.append(trim_filter)

                delay_ms = (nested_clip["start_frame"] / fps) * 1000
                delay_filter = f"[t{i}]adelay={int(delay_ms)}|{int(delay_ms)}[d{i}];"
                filter_complex_parts.append(delay_filter)
                delayed_streams.append(f"[d{i}]")

            mix_inputs = "".join(delayed_streams)
            amix_filter = (
                f"{mix_inputs}amix=inputs={len(nested_clips)}:dropout_transition=0[out]"
            )
            filter_complex_parts.append(amix_filter)

            ffmpeg_cmd = [FFMPEG, "-y"]
            for source_file in unique_source_files:
                ffmpeg_cmd.extend(["-i", source_file])

            ffmpeg_cmd.extend(
                [
                    "-filter_complex",
                    "".join(filter_complex_parts),
                    "-map",
                    "[out]",
                    "-ac",
                    "1",
                    output_wav_path,
                ]
            )
            subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        elif needs_render:  # This implies not STANDALONE_MODE
            print(
                f"Go Mode: Skipping local render for new content ID {content_uuid}. Go will handle it."
            )
        else:
            print(
                f"Content for '{representative_item['name']}' is unchanged. Skipping render."
            )

        # --- [REFACTORED] Update all timeline items in this content group ---
        # This logic now correctly separates the I/O check from the data update.
        should_update_datastructure = False
        if not STANDALONE_MODE:
            # In Go mode, we don't check the disk. We trust Go to create the file.
            # We always proceed to update the data structure.
            should_update_datastructure = True
        else:
            # In Standalone mode, we only update the data if the file was successfully created.
            should_update_datastructure = os.path.exists(output_wav_path)

        if should_update_datastructure:
            # This block runs for all items in Go mode, or only for successful renders in Standalone mode.
            for tl_item in items_in_group:
                tl_item["processed_file_name"] = output_filename
                tl_item["source_file_path"] = output_wav_path
                tl_item["source_start_frame"] = 0.0
                tl_item["source_end_frame"] = (
                    tl_item["end_frame"] - tl_item["start_frame"]
                )
        else:
            # This 'else' branch will now only be triggered in standalone mode if a render fails.
            print(
                f"ERROR: Failed to create or find mixdown for content ID: {content_uuid}"
            )


def _standardize_audio_stream_worker(item: TimelineItem, target_dir: str):
    """
    Worker function that creates a single standardized WAV file, either by
    mono-mixing or by extracting a specific channel. Skips if the file exists.
    """
    global FFMPEG

    source_path = item["source_file_path"]
    # Default to 0 (mixdown) if source_channel is not specified
    channel = item.get("source_channel", 0)
    output_filename = item["processed_file_name"]

    if not output_filename:
        return

    output_path = os.path.join(target_dir, output_filename)

    # Skip if a valid file already exists
    if misc_utils.is_valid_audio(output_path):
        return

    ffmpeg_cmd = [FFMPEG, "-y", "-i", source_path]
    if channel > 0:
        # Channel-specific extraction. ffmpeg is 0-indexed, DaVinci API is 1-indexed.
        print(f"Extracting channel {channel} from '{os.path.basename(source_path)}'")
        ffmpeg_cmd.extend(["-map_channel", f"0.0.{channel - 1}", output_path])
    else:
        # Standard mono mixdown
        print(f"Creating mono mixdown for '{os.path.basename(source_path)}'")
        ffmpeg_cmd.extend(["-vn", "-acodec", "pcm_s16le", "-ac", "1", output_path])

    subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def standardize_all_audio_streams(
    items: list[TimelineItem], target_dir: str, max_workers=4
):
    """
    Processes all timeline items concurrently, creating the necessary WAV files.
    """
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Create a dict to de-duplicate jobs. We only need to process each unique
        # target file once.
        unique_jobs = {
            item["processed_file_name"]: item
            for item in items
            if item.get("processed_file_name")
        }

        # Run the worker function for each unique job
        executor.map(
            lambda item: _standardize_audio_stream_worker(item, target_dir),
            unique_jobs.values(),
        )


def get_project_data(project, timeline) -> Tuple[bool, str | None]:
    """
    (REVISED) Analyzes timeline items and channel mappings, then conditionally processes
    them if running in standalone mode.
    """
    global PROJECT, MEDIA_POOL, STANDALONE_MODE, TEMP_DIR

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
    globalz.PROJECT_DATA = {
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
        source_uuid = misc_utils.uuid_from_path(source_path).hex

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
        if source_path not in globalz.PROJECT_DATA["files"]:
            globalz.PROJECT_DATA["files"][source_path] = {
                "properties": {"FPS": timeline_fps},
                "timelineItems": [],
                "fileSource": {
                    "file_path": source_path,
                    "uuid": misc_utils.uuid_from_path(source_path).hex,
                    "bmd_media_pool_item": item["bmd_mpi"],
                },
                "silenceDetections": None,
                # Note: 'processed_audio_path' is no longer relevant in this map,
                # as all processing is now per-timeline-item.
            }

    # --- 4. Handle Compound Clips ---
    if any(item.get("type") for item in audio_track_items):
        print("Complex clips found...")
        mixdown_compound_clips(audio_track_items, timeline_fps, [])

    # --- 5. Perform Processing ONLY if in Standalone Mode ---
    if STANDALONE_MODE:
        print("Standalone Mode: Standardizing all required audio streams...")
        standardize_all_audio_streams(audio_track_items, TEMP_DIR)

        print("Standalone Mode: Detecting silence...")
        all_processed_files = {
            item["processed_file_name"]
            for item in audio_track_items
            if item.get("processed_file_name")
        }

        wavs_for_silence_detection: list[AudioFromVideo] = [
            {
                "audio_file_path": os.path.join(TEMP_DIR, fname),
                "video_file_path": fname,
                "silence_intervals": [],
            }
            for fname in all_processed_files
            if misc_utils.is_valid_audio(os.path.join(TEMP_DIR, fname))
        ]
        silence_results = detect_silence_parallel(
            wavs_for_silence_detection, timeline_fps
        )

        for item in audio_track_items:
            if (
                item.get("processed_file_name")
                and item["processed_file_name"] in silence_results
            ):
                silence_intervals = silence_results[item["processed_file_name"]][
                    "silence_intervals"
                ]
                clip_data: ClipData = {
                    "start_frame": item["start_frame"],
                    "end_frame": item["end_frame"],
                    "source_start_frame": item["source_start_frame"],
                    "source_end_frame": item["source_end_frame"],
                }
                item["edit_instructions"] = create_edits_with_optional_silence(
                    clip_data, silence_intervals
                )

    print("Python-side analysis complete.")
    return True, None


def merge_project_data(project_data_from_go: ProjectData) -> None:
    """Use everything from go except keys which values are <BMDObject> (string)"""
    global TEMP_DIR

    if not globalz.PROJECT_DATA:
        globalz.PROJECT_DATA = {}
    for key, value in project_data_from_go.items():
        if value == "<BMDObject>":
            continue
        globalz.PROJECT_DATA[key] = value

    debug_output = os.path.join(TEMP_DIR, "debug_project_data_from_go.json")
    misc_utils.export_to_json(globalz.PROJECT_DATA, debug_output)

    return


def deep_merge_bmd_aware(
    target_dict: ProjectData, source_dict: Mapping[str, Any]
) -> None:
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


def apply_edits_from_go(
    target_project: ProjectData, source_project: ProjectData
) -> None:
    """
    Applies ONLY the 'edit_instructions' from a source project data structure
    to the target, matching audio timeline items by their unique ID.

    This function is intentionally simple to robustly update the target with
    the essential data from the frontend without side effects.
    """
    print("Applying edit instructions from Go...")
    pprint.pprint(source_project)

    # Create an efficient lookup map of the audio items sent from Go.
    source_audio_items = source_project.get("timeline", {}).get("audio_track_items", [])
    source_items_by_id = {
        item["id"]: item for item in source_audio_items if "id" in item
    }

    if not source_items_by_id:
        print(
            "Warning: No audio items with IDs found in data from Go. No edits applied."
        )
        return

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


def tl_has_nested_item() -> bool:
    print("checking if tl has nested item")
    project_data = globalz.PROJECT_DATA
    if not project_data:
        return False

    all_tl_items = (
        project_data["timeline"]["audio_track_items"]
        + project_data["timeline"]["video_track_items"]
    )

    for item in all_tl_items:
        item_type = item.get("type")
        if not item_type:
            continue
        return True

    return False


def setTimecode(timecode: str, task_id: str = "") -> bool:
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

    script_start_time: float = time()

    if not sync:
        TRACKER.start_new_run(globalz.TASKS, task_id)
        TRACKER.update_task_progress("init", 0.1, message="Preparing")

    if not RESOLVE:
        task_id = task_id or ""
        get_resolve(task_id)
    print("hello?")
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
            "message": message,
            "data": globalz.PROJECT_DATA,
            "shouldShowAlert": True,
            "alertTitle": "No Open Timeline",
            "alertMessage": message,  # Specific message for the alert
            "alertSeverity": "error",
        }

        send_message_to_go("taskResult", response_payload, task_id=task_id)
        return False

    # export state of current timeline to otio, EXPENSIVE
    input_otio_path = os.path.join(TEMP_DIR, "temp-timeline.otio")

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
            print(response_payload)
            output_dir = os.path.join(TEMP_DIR, "debug_project_data.json")

            print(f"exporting debug json to {output_dir}")
            misc_utils.export_to_json(globalz.PROJECT_DATA, output_dir)
            send_message_to_go("taskResult", response_payload, task_id=task_id)
            return

    if sync or STANDALONE_MODE:
        output_dir = os.path.join(TEMP_DIR, "debug_project_data.json")
        print(f"exporting debug json to {output_dir}")
        misc_utils.export_to_json(globalz.PROJECT_DATA, output_dir)

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
        export_timeline_to_otio(TIMELINE, file_path=input_otio_path)
        print(f"Exported timeline to OTIO in {input_otio_path}")
        if not STANDALONE_MODE:
            return

    if not globalz.PROJECT_DATA:
        alert_message = "An unexpected error happened during sync. Could not get project data from Davinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return

    # safety check: do we have bmd items?
    all_timeline_items = (
        globalz.PROJECT_DATA["timeline"]["video_track_items"]
        + globalz.PROJECT_DATA["timeline"]["audio_track_items"]
    )

    if not all_timeline_items:
        print("critical error, can't continue")
        alert_message = "An unexpected error happened during sync. Could not get timeline items from Davinci."
        send_result_with_alert("unexpected sync error", alert_message, task_id)
        return

    some_bmd_item = all_timeline_items[0]["bmd_item"]
    if not some_bmd_item or isinstance(some_bmd_item, str):
        print("critical error, can't continue")
        return

    unify_linked_items_in_project_data(input_otio_path)

    TRACKER.complete_task("prepare")
    TRACKER.update_task_progress("append", 1.0, "Adding Clips to Timeline")

    append_and_link_timeline_items(MAKE_NEW_TIMELINE)

    TRACKER.complete_task("append")

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


def _append_clips_to_timeline(
    timeline: Any, media_pool: Any, timeline_items: List[TimelineItem]
) -> Tuple[List[Tuple[Dict, Tuple[int, int]]], List[Any]]:
    clips_to_process: List[Tuple[Dict, Tuple[int, int]]] = []
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

            if not item["bmd_item"] or isinstance(item["bmd_item"], str):
                raise TypeError("Could not get timeline item from DaVinci Script API")

            if not item.get("bmd_mpi"):
                item["bmd_mpi"] = item["bmd_item"].GetMediaPoolItem()

            clip_info_for_api: Dict = {
                "mediaPoolItem": item["bmd_mpi"],
                "startFrame": source_start,
                "endFrame": source_end,
                "recordFrame": round(edit.get("start_frame", 0)),
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

    if not globalz.PROJECT_DATA:
        return
    project_data = globalz.PROJECT_DATA
    if not project_data.get("timeline"):
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
            timeline.SetStartTimecode(
                globalz.PROJECT_DATA["timeline"]["start_timecode"]
            )
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
    num_retries = 4
    sleep_time_between = 2.5
    TRACKER.update_task_progress("append", 1.0, message="Adding Clips to Timeline")
    for attempt in range(1, num_retries + 1):
        # The internal function returns our "source of truth" and the API's response
        processed_clips, bmd_items_from_api = _append_clips_to_timeline(
            timeline, media_pool, timeline_items
        )
        TRACKER.complete_task("append")
        if not processed_clips:
            success = True
            break

        # Use the list of clips we INTENDED to create for verification
        expected_clip_infos = [item[0] for item in processed_clips]
        if _verify_timeline_state(timeline, expected_clip_infos, attempt):
            TRACKER.complete_task("verify")
            print("Verification successful. Proceeding to link.")

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
            length_link_groups = len(link_groups.items())
            index = 1
            for group_key, clips_to_link in link_groups.items():
                if len(clips_to_link) >= 2:
                    print(
                        f"Linking {len(clips_to_link)} clips for group {group_key}..."
                    )

                    timeline.SetClipsLinked(clips_to_link, True)
                if index % 10 == 1:
                    percentage = (index / length_link_groups) * 100
                    TRACKER.update_task_progress("link", percentage, "Linking clips...")
                index += 1
            TRACKER.complete_task("link")

            print("✅ Operation completed successfully.")
            success = True
            break
        else:
            print(f"Attempt {attempt} failed. Rolling back changes...")
            verify_percentage = (attempt / num_retries) * 100
            TRACKER.update_task_progress(
                "verify", verify_percentage, "Verification failed. Retrying..."
            )
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


# Add this new global event
go_server_ready_event = threading.Event()

def wait_for_go_ready(go_server_port: int) -> bool:
    """
    Waits for the Go server to signal its readiness by successfully connecting to its /ready endpoint.
    """
    print(f"Python Backend: Waiting for Go server to register...", flush=True)
    # Wait for the event to be set by the /register endpoint
    event_was_set = go_server_ready_event.wait(timeout=25) # 25 second timeout
    if not event_was_set:
        print("Python Backend: Timed out waiting for Go server to register.", flush=True)
        return False
    
    print("Python Backend: Go server has registered.", flush=True)
    return True

class PythonCommandHandler(BaseHTTPRequestHandler):
    def _send_json_response(self, status_code, data_dict):
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data_dict).encode("utf-8"))

    def do_POST(self):
        global GO_SERVER_PORT
        if self.path == "/register":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                port = data.get("go_server_port")
                if port:
                    GO_SERVER_PORT = port
                    print(f"Python Command Server: Registered Go server on port {port}", flush=True)
                    self._send_json_response(200, {"status": "success", "message": "Go server registered."})
                    go_server_ready_event.set() # Signal that Go is ready
                else:
                    self._send_json_response(400, {"status": "error", "message": "Missing 'go_server_port' in request."})
            except json.JSONDecodeError:
                self._send_json_response(400, {"status": "error", "message": "Invalid JSON."})
            return
        
        # ... (rest of the do_POST method is unchanged)
        global MAKE_NEW_TIMELINE
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
                project_data_from_go_raw = params.get("projectData")
                MAKE_NEW_TIMELINE = params.get("makeNewTimeline", False)

                if not project_data_from_go_raw:
                    # Handle case where no data is sent
                    # (You might want to add a proper error response here)
                    return

                # Assuming project_data_from_go_raw is a dict
                project_data_from_go = ProjectData(**project_data_from_go_raw)

                response_payload = {
                    "status": "success",
                    "message": "Final timeline generation started.",
                }
                self._send_json_response(200, response_payload)

                # FIX: Check for None before calling the function
                if globalz.PROJECT_DATA:
                    apply_edits_from_go(globalz.PROJECT_DATA, project_data_from_go)

                else:
                    # If no data exists yet, the incoming data becomes the new base
                    globalz.PROJECT_DATA = project_data_from_go

                main(sync=False, task_id=task_id)
                return

            elif command == "saveProject":
                print("Python: Simulating project save...", flush=True)
                response_payload = {
                    "status": "success",
                    "message": "Project save command received.",
                }
            elif command == "setPlayhead":
                time_value = params.get("time")
                if time_value is not None and setTimecode(time_value, task_id):
                    response_payload = {
                        "status": "success",
                        "message": f"Playhead position set to {time_value}.",
                    }
                else:
                    self._send_json_response(
                        400,
                        {
                            "status": "error",
                            "message": "Could not set playhead for current timeline.",
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
    global FFMPEG

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "-gp", "--go-port", type=int, default=8080
    )  # port to communicate with http server
    parser.add_argument(
        "-lp", "--listen-on-port", type=int, default=8081
    )  # port to receive commands from go
    parser.add_argument("--auth-token", type=str)  # authorization token
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("-s", "--sync", action="store_true")
    parser.add_argument("--standalone", action="store_true")
    parser.add_argument("--launch-go", action="store_true", help="Launch the Go Wails application after Python backend starts.")
    parser.add_argument("--wails-dev", action="store_true", help="Launch the Go Wails application in development mode (wails dev).")
    args = parser.parse_args()

    GO_SERVER_PORT = args.go_port
    FFMPEG = args.ffmpeg

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
        
    if args.wails_dev:
        print("Python Backend: Launching Go Wails application in development mode...", flush=True)
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

        # Check if 'wails' command is available
        try:
            subprocess.run(["wails", "version"], check=True, capture_output=True)
        except FileNotFoundError:
            print("Python Backend: Error: 'wails' command not found. Please ensure Wails CLI is installed and in your system's PATH.", flush=True)
            sys.exit(1)
        except subprocess.CalledProcessError as e:
            print(f"Python Backend: Error running 'wails version': {e.stdout.decode()}{e.stderr.decode()}", flush=True)
            sys.exit(1)

        # Pass the Python command port via an environment variable for wails dev
        env = os.environ.copy()
        env["WAILS_PYTHON_PORT"] = str(args.listen_on_port)
        wails_dev_command = ["wails", "dev"]
        try:
            # Use Popen to run in the background and not block the Python script
            # Capture stdout/stderr to help diagnose issues
            process = subprocess.Popen(wails_dev_command, cwd=project_root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            print(f"Python Backend: 'wails dev' launched with command: {wails_dev_command} in {project_root}", flush=True)

            # Read and print output in a non-blocking way (for debugging)
            def read_output(pipe, prefix):
                for line in pipe:
                    print(f"[{prefix}] {line.strip()}", flush=True)

            threading.Thread(target=read_output, args=(process.stdout, "WAILS_STDOUT"), daemon=True).start()
            threading.Thread(target=read_output, args=(process.stderr, "WAILS_STDERR"), daemon=True).start()

            # Go application registers with Python, so no need for Python to wait for Go or signal back.
            # The Python command server is already running and listening for Go's registration.
            print("Python Backend: Go application launch initiated. Waiting for Go to register.", flush=True)

        except Exception as e:
            print(f"Python Backend: Error launching 'wails dev': {e}", flush=True)
    else:
        print("Python Backend: Launching Go Wails application...", flush=True)
        go_app_path = ""
        if sys.platform.startswith("darwin"):
            # For macOS, check both the .app bundle path (production) and direct executable path (development)
            app_bundle_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "build", "bin", "HushCut.app", "Contents", "MacOS", "HushCut"))
            dev_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "build", "bin", "HushCut"))
            print(f"Python Backend: Checking app bundle path: {app_bundle_path}", flush=True)
            if os.path.exists(app_bundle_path):
                print("Python Backend: App bundle path exists.", flush=True)
                go_app_path = app_bundle_path
            else:
                print("Python Backend: App bundle path does NOT exist.", flush=True)
            
            print(f"Python Backend: Checking dev path: {dev_path}", flush=True)
            if os.path.exists(dev_path):
                print("Python Backend: Dev path exists.", flush=True)
                go_app_path = dev_path
            else:
                print("Python Backend: Dev path does NOT exist.", flush=True)
        elif sys.platform.startswith("win"):
            go_app_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "build", "bin", "HushCut.exe"))
        elif sys.platform.startswith("linux"):
            go_app_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "build", "bin", "HushCut"))

        if not os.path.exists(go_app_path):
            print(f"Python Backend: Error: Go Wails application not found at {go_app_path}", flush=True)
        else:
            go_command = [go_app_path, f"--python-port={args.listen_on_port}"]
            try:
                subprocess.Popen(go_command)
                print(f"Python Backend: Go Wails application launched with command: {go_command}", flush=True)
            except Exception as e:
                print(f"Python Backend: Error launching Go Wails application: {e}", flush=True)
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
