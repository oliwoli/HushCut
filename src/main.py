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
    Optional,
    TypedDict,
    Union,
)
import os
import sys
import subprocess
import re
from dotenv import load_dotenv
import json
from concurrent.futures import ThreadPoolExecutor, as_completed


from edit_silence import (
    create_edits_with_optional_silence,
    ClipData,
    SilenceInterval,
    EditInstruction,
)

import misc_utils


class FileProperties(TypedDict):
    FPS: float


class TimelineProperties(TypedDict):
    name: str
    FPS: float
    item_usages: List[TimelineItem]


class EditFrames(TypedDict):
    start_frame: int
    end_frame: int
    source_start_frame: int
    source_end_frame: int
    duration: int


class TimelineItem(TypedDict):
    bmd_item: Any
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
    silenceDetections: Optional[List[SilenceInterval]]
    timelineItems: list[TimelineItem]
    fileSource: FileSource


class ProjectData(TypedDict):
    project_name: str
    timeline: Timeline
    files: Dict[str, FileData]


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


class FileSource(TypedDict):
    bmd_media_pool_item: Any
    file_path: str
    uuid: str


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
    success = timeline.Export(file_path, resolve.EXPORT_OTIO)
    if success:
        print(f"Timeline exported successfully to {file_path}")
    else:
        print("Failed to export timeline.")


if not load_dotenv():
    raise FileNotFoundError(".env file not found.")


class AudioFromVideo(TypedDict):
    video_bmd_media_pool_item: Any
    video_file_path: str
    audio_file_path: str
    audio_file_uuid: str
    audio_file_name: str
    silence_intervals: List[SilenceInterval]


def extract_audio(file: Any, root_dir) -> AudioFromVideo | None:
    filepath = file.get("file_path")
    if not filepath or not os.path.exists(filepath):
        return

    basename = os.path.basename(filepath)
    print(f"Processing file: {basename}")

    wav_path = os.path.join(root_dir, "temp", f"{os.path.basename(file['uuid'])}.wav")

    audio_from_video: AudioFromVideo = {
        "audio_file_name": os.path.basename(wav_path),
        "audio_file_path": wav_path,
        "audio_file_uuid": file["uuid"],
        "video_file_path": filepath,
        "video_bmd_media_pool_item": file["bmd_media_pool_item"],
        "silence_intervals": [],
    }

    if misc_utils.is_valid_audio(wav_path):
        print(f"{wav_path} is valid audio")
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
        wav_path,
    ]
    subprocess.run(audio_extract_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return audio_from_video


def process_audio_files(
    audio_source_files, root_dir, max_workers=4
) -> list[AudioFromVideo]:
    """Runs audio extraction in parallel using ThreadPoolExecutor."""
    print(f"audio source files: {audio_source_files}")
    print(f"root dir: {root_dir}")

    start_time = time()

    audios_from_video: list[AudioFromVideo] = []

    print(f"Starting audio extraction with {max_workers} workers.")
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(extract_audio, file, root_dir)
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
    print(f"Running silence detection on: {audio_file['audio_file_name']}")
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
    start_time = time()
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


resolve = get_resolve()


ResolvePage = Literal["edit", "color", "fairlight", "fusion", "deliver"]


def switch_to_page(page: ResolvePage) -> None:
    global resolve
    current_page = resolve.GetCurrentPage()
    if current_page != page:
        resolve.OpenPage(page)
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
            print(item)
            timeline_item: TimelineItem = {
                "bmd_item": item,
                "duration": item.GetDuration(),
                "name": item.GetName(),
                "edit_instructions": [],
                "start_frame": item.GetStart(),
                "end_frame": item.GetEnd(),
                "id": get_item_id(item),
                "track_type": track_type,
                "track_index": i,
                "source_file_path": item.GetMediaPoolItem().GetClipProperty(
                    "File Path"
                ),
                "source_start_frame": item.GetSourceStartFrame(),
                "source_end_frame": item.GetSourceEndFrame(),
            }
            items.append(timeline_item)

    return items


def get_source_media_from_timeline_item(
    timeline_item: TimelineItem,
) -> Union[FileSource, None]:
    print(timeline_item)
    media_pool_item = timeline_item["bmd_item"].GetMediaPoolItem()
    if not media_pool_item:
        return None
    filepath = media_pool_item.GetClipProperty("File Path")
    if not filepath:
        return None
    file_path_uuid: str = misc_utils.uuid_from_path(filepath).hex
    source_media_item: FileSource = {
        "file_path": filepath,
        "uuid": file_path_uuid,
        "bmd_media_pool_item": media_pool_item,
    }
    return source_media_item


def main() -> None:
    global resolve
    script_start_time: float = time()
    if not resolve:
        print("Could not connect to DaVinci Resolve. Is it running?")
        # GetResolve already prints detailed errors if loading DaVinciResolveScript fails
        sys.exit(1)

    switch_to_page("edit")
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        print("No project is currently open.")
        sys.exit(1)

    timeline = project.GetCurrentTimeline()

    if not timeline:
        print("No timeline is currently open.")
        sys.exit(1)

    timeline_name = timeline.GetName()
    timeline_fps = timeline.GetSetting("timelineFrameRate")
    curr_timecode = timeline.GetCurrentTimecode()

    current_file_path = os.path.dirname(os.path.abspath(__file__))
    # export state of current timeline to otio
    otio_file_path = os.path.join(current_file_path, f"pre-edit_timeline_export.otio")
    export_timeline_to_otio(timeline, file_path=otio_file_path)
    print(f"Exported timeline to OTIO in {otio_file_path}")

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

    audio_source_files: list[FileSource] = []
    media_pool_items: list[Any] = []
    for item in audio_track_items:
        print(f"Processing audio item: {item['name']}")
        source_media_item = get_source_media_from_timeline_item(item)
        if not source_media_item:
            continue
        if source_media_item in audio_source_files:
            continue
        audio_source_files.append(source_media_item)

    if len(audio_source_files) == 0:
        print("No file paths to process.")
        sys.exit(1)

    print(f"Source media files count: {len(audio_source_files)}")

    silence_start_re = re.compile(r"silence_start: (?P<start>\d+\.?\d*)")
    silence_end_re = re.compile(r"silence_end: (?P<end>\d+\.?\d*)")
    silence_duration_re = re.compile(r"silence_duration: (?P<duration>\d+\.?\d*)")

    silence_detect_time_start = time()

    root_dir = os.path.dirname(os.path.abspath(__file__))

    # make the temp directory if it doesn't exist
    temp_dir = os.path.join(root_dir, "temp")
    if not os.path.exists(temp_dir):
        os.makedirs(temp_dir)
        print(f"Created temp directory: {temp_dir}")

    processed_audio_paths: list[AudioFromVideo] = process_audio_files(
        audio_source_files, root_dir
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

    for item in project_data["timeline"]["audio_track_items"]:
        print(f"Processing item: {item}")
        bmd_item = item["bmd_item"]
        clip_name = bmd_item.GetName()
        clip_start_frame_timeline = item["start_frame"]
        clip_start_frame_source = item["source_start_frame"]
        clip_end_frame_timeline = item["end_frame"]
        clip_end_frame_source = item["source_end_frame"]
        clip_duration = bmd_item.GetDuration()
        clip_linked_items = bmd_item.GetLinkedItems()
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

        linked_items_file_paths = [
            item.GetMediaPoolItem().GetClipProperty("File Path")
            for item in clip_linked_items
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

    current_file_path = os.path.dirname(os.path.abspath(__file__))
    json_output_path = os.path.join(current_file_path, "silence_detections.json")
    misc_utils.export_to_json(project_data, json_output_path)

    # let's just run create_otio.py as subprocess.run for now
    subprocess.run([sys.executable, os.path.join(current_file_path, "create_otio.py")])
    import_otio_file_path = os.path.join(
        current_file_path, "edited_timeline_refactored.otio"
    )
    timeline_name = f"{timeline_name} - Silence Detection{time()}"
    imported_timeline = import_otio_timeline(
        import_otio_file_path, project, timeline_name
    )
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
    otio_file_path = os.path.join(current_file_path, f"temp_timeline_export2.otio")
    export_timeline_to_otio(edit_timeline, file_path=otio_file_path)
    export_otio_endtime = time()
    export_otio_exec_time = export_otio_endtime - export_otio_start
    print(
        f"Exported timeline to XML in {export_otio_exec_time:.2f} seconds. File path: {otio_file_path}"
    )


def get_item_id(item: Any) -> str:
    track_type_and_index = item.GetTrackTypeAndIndex()
    track_type = track_type_and_index[0]
    track_index = track_type_and_index[1]
    start_frame = item.GetStart()
    return f"{item.GetName()}-{track_type}-{track_index}--{start_frame}"


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


def make_edit_timeline(project_data: ProjectData, project) -> None:
    global resolve
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

    switch_to_page("edit")
    resolve.OpenPage("edit")
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


def import_otio_timeline(
    otio_file_path: str, project: Any, timeline_name: str
) -> Any | None:
    media_pool = project.GetMediaPool()
    timeline = media_pool.ImportTimelineFromFile(
        otio_file_path, {"timelineName": timeline_name}
    )
    if not timeline:
        print("Failed to import OTIO timeline.")
        return
    print(f"Imported OTIO timeline: {timeline}")
    return timeline


if __name__ == "__main__":
    # current_file_path = os.path.dirname(os.path.abspath(__file__))
    # import_otio_file_path = os.path.join(
    #     current_file_path, "edited_timeline_refactored.otio"
    # )
    # print(f"Importing OTIO file: {import_otio_file_path}")
    # timeline_name = f"OTIO test - Silence Detection"
    # project = resolve.GetProjectManager().GetCurrentProject()
    # print(f"Project: {project.GetName()}")
    # imported_timeline = import_otio_timeline(
    #     import_otio_file_path, project, timeline_name
    # )
    # sys.exit(1)

    script_time = time()
    main()
    script_end_time = time()
    script_execution_time = script_end_time - script_time
    print(f"Script finished successfully in {script_execution_time:.2f} seconds.")
