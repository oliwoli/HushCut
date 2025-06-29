#!/usr/bin/env python3

from __future__ import annotations
import math
from statistics import median_grouped
from subprocess import CompletedProcess
from time import time
from typing import (
    Any,
    Dict,
    List,
    Literal,
    NotRequired,
    Optional,
    TypeAlias,
    TypedDict,
    Union,
)

import os
import sys
import subprocess
import re
from dotenv import load_dotenv
import json


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
some_uuid: str = bmd.createuuid("randomString")  # probably need this later

if not resolve:
    print("Could not connect to DaVinci Resolve. Is it running?")
    # GetResolve already prints detailed errors if loading DaVinciResolveScript fails
    sys.exit(1)

print(dir(bmd))
clipboard = bmd.getclipboard()
print(clipboard)
print(dir(clipboard))
