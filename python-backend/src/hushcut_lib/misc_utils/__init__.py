import copy
import json
import os
import sys
from typing import Any, Dict
import uuid
import subprocess
from subprocess import CompletedProcess


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
