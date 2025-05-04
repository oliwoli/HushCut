import json
import os
from typing import Any
from uuid import UUID
import uuid
import subprocess
from subprocess import CompletedProcess


def uuid_from_path(path: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, path)


def sec_to_frames(seconds: float, fps: float) -> float:
    """Converts time in seconds to frame number using ceiling."""
    if fps <= 0:
        raise ValueError("FPS must be positive")
    return seconds * fps


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


def export_to_json(project_data: Any, output_path: str) -> None:
    with open(output_path, "w") as json_file:
        json.dump(project_data, json_file, indent=4)
