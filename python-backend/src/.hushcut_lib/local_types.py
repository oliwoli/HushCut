from typing import Any, List, Dict, Literal, Optional, TypedDict


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
