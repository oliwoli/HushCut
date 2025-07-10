#!/usr/bin/env python

"""
This file serves to return a DaVinci Resolve object
"""

from typing import Any, Union


import sys


def load_source(module_name, file_path):
    if sys.version_info[0] >= 3 and sys.version_info[1] >= 5:
        import importlib.util

        module = None
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec and spec.loader:
            module = importlib.util.module_from_spec(spec)
            if module:
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
        return module
    else:
        # For Python versions older than 3.5, imp is used.
        # This branch might not be reached in modern environments.
        # Adding type ignore as imp is deprecated and might not be found by Pyright.
        import imp # type: ignore

        return imp.load_source(module_name, file_path) # type: ignore


def GetResolve() -> Union[Any, None]:
    expectedPath: str = ""
    try:
        import DaVinciResolveScript as bmd # type: ignore
    except ImportError:
        if sys.platform.startswith("darwin"):
            expectedPath = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/"
        elif sys.platform.startswith("win") or sys.platform.startswith("cygwin"):
            import os

            expectedPath = (
                (os.getenv("PROGRAMDATA") or "")
                + "\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\Modules\\"
            )
        elif sys.platform.startswith("linux"):
            expectedPath = "/opt/resolve/Developer/Scripting/Modules/"

        # check if the default path has it...
        print(
            "Unable to find module DaVinciResolveScript from $PYTHONPATH - trying default locations"
        )
        try:
            load_source(
                "DaVinciResolveScript", expectedPath + "DaVinciResolveScript.py"
            )
            import DaVinciResolveScript as bmd # type: ignore
        except Exception as ex:
            # No fallbacks ... report error:
            print(
                "Unable to find module DaVinciResolveScript - please ensure that the module DaVinciResolveScript is discoverable by python"
            )
            print(
                "For a default DaVinci Resolve installation, the module is expected to be located in: "
                + expectedPath
            )
            print(ex)
            return None
    return bmd.scriptapp("Resolve")


if __name__ == "__main__":
    GetResolve()
