#!/usr/bin/env python3

from __future__ import annotations
import math
from statistics import median_grouped
from subprocess import CompletedProcess
from time import time
from typing import Any, Dict, List, TypeAlias, TypedDict

import os
import sys
import subprocess
import re
from dotenv import load_dotenv
import json

start_time: float = time()

if not load_dotenv():
    print(
        "Warning: .env file not found. Ensure it is in the same directory as this script."
    )

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

some_uuid: str = bmd.createuuid("randomString")  # probably need this later

if not resolve:
    print("Could not connect to DaVinci Resolve. Is it running?")
    # GetResolve already prints detailed errors if loading DaVinciResolveScript fails
    sys.exit(1)
time_init = time() - start_time
start_time_resolve_init: float = time()

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

timeline = project.GetCurrentTimeline()
timeline_fps = timeline.GetSetting("timelineFrameRate")
print(f"Timeline FPS: {timeline_fps}")
if not timeline:
    print("No timeline is currently open.")
    sys.exit(1)

current_dir = os.path.dirname(os.path.abspath(__file__))
xml_file_path = os.path.join(current_dir, "test_xml.xml")

print(f"XML file path: {xml_file_path}")

mediapool = project.GetMediaPool()
if not mediapool:
    print("Could not get MediaPool.")
    sys.exit(1)

mediapool.ImportTimelineFromFile(
    xml_file_path, {"timelineName": "Imported Timeline via Script API"}
)

end_time = time() - start_time
print(f"Full runtime: {end_time:.2f} seconds")
print(f"Time to init resolve: {time_init:.2f} seconds")
print(f"Time to import XML: {end_time - time_init:.2f} seconds")
