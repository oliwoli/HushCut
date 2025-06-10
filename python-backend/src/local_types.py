from typing import Any, List, Dict, Literal, NotRequired, Optional, TypedDict


class ClipData(TypedDict):
    source_start_frame: float
    source_end_frame: float  # Inclusive end point/time
    start_frame: float
    end_frame: float


class SilenceInterval(TypedDict):
    start: float  # Inclusive source frame/time
    end: float  # Exclusive source frame/time


class EditInstruction(TypedDict):
    source_start_frame: float  # Precise source start point/time (inclusive)
    source_end_frame: float  # Precise source end point/time (inclusive)
    start_frame: float  # Calculated timeline start frame (inclusive)
    end_frame: float  # Calculated timeline end frame (inclusive)
    enabled: bool  # TODO: move this into TimelineItem instead, maybe rename to "enabled_in_edit"


class FileProperties(TypedDict):
    FPS: float


class TimelineItem(TypedDict):
    bmd_item: Any
    name: str
    id: str
    track_type: Literal["video", "audio", "subtitle"]
    track_index: int
    source_file_path: str
    processed_file_name: str
    start_frame: float
    end_frame: float
    source_start_frame: float
    source_end_frame: float
    duration: float
    edit_instructions: list[EditInstruction]
    link_group_id: NotRequired[int]


def make_empty_timeline_item() -> TimelineItem:
    return {
        "bmd_item": None,
        "name": "",
        "id": "",
        "track_type": "video",  # or some default
        "track_index": 0,
        "source_file_path": "",
        "processed_file_name": "",
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
    silenceDetections: Optional[List[SilenceInterval]]
    timelineItems: list[TimelineItem]
    fileSource: FileSource


class Timeline(TypedDict):
    name: str
    fps: float
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
