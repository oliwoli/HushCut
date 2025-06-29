#!/usr/bin/env python

"""
This file serves to return a DaVinci Resolve object
"""

import sys

def load_source(module_name, file_path):
    if sys.version_info[0] >= 3 and sys.version_info[1] >= 5:
        import importlib.util

        module = None
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec:
            module = importlib.util.module_from_spec(spec)
        if module:
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        return module
    else:
        import imp
        return imp.load_source(module_name, file_path)


def GetResolve():
    try:      
        # The PYTHONPATH needs to be set correctly for this import statement to work.
        # An alternative is to import the DaVinciResolveScript by specifying absolute path (see ExceptionHandler logic)
        import DaVinciResolveScript as bmd
    except ImportError:
        expectedPath = "/opt/resolve/Developer/Scripting/Modules/"

        # check if the default path has it...
        print("Unable to find module DaVinciResolveScript from $PYTHONPATH - trying default locations")
        try:
            load_source('DaVinciResolveScript', expectedPath + "DaVinciResolveScript.py")
            import DaVinciResolveScript as bmd
        except Exception as ex:
            # No fallbacks ... report error:
            print("The module is expected to be located in: " + expectedPath)
            print(ex)
            sys.exit()
    print("DaVinciResolveScript module loaded successfully")

    return bmd.scriptapp("Resolve")


if __name__ == "__main__":
    GetResolve()
