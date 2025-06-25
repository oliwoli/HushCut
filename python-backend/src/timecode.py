#!/usr/bin/env python3

from __future__ import annotations
from time import time, sleep
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

import misc_utils

from local_types import (
    Timeline,
    TimelineItem,
    FileSource,
    ProjectData,
)

from pprint import pprint
import opentimelineio as otio


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


# GLOBALS
RESOLVE = get_resolve()

ResolvePage = Literal["edit", "color", "fairlight", "fusion", "deliver"]


def switch_to_page(page: ResolvePage) -> None:
    global RESOLVE
    current_page = RESOLVE.GetCurrentPage()
    if current_page != page:
        RESOLVE.OpenPage(page)
        print(f"Switched to {page} page.")
    else:
        print(f"Already on {page} page.")


def get_source_media_from_timeline_item(
    timeline_item: TimelineItem,
) -> Union[FileSource, None]:
    media_pool_item = timeline_item["bmd_item"].GetMediaPoolItem()
    if not media_pool_item:
        return None
    filepath = media_pool_item.GetClipProperty("File Path")
    if not filepath:
        # print(f"File path not found for item: {timeline_item['name']}")
        # # print metadata
        # print(f"tl item properties: {timeline_item['bmd_item'].GetProperty()}")
        # print(f"Clip property: {media_pool_item.GetClipProperty()}")
        # print(f"Metadata: {media_pool_item.GetMetadata()}")
        # print(f"Selected Take: {timeline_item["bmd_item"].GetSelectedTakeIndex()}")
        # print(f"Fusion comp count: {timeline_item['bmd_item'].GetFusionCompCount()}")
        # print(f"takes count: {timeline_item['bmd_item'].GetTakesCount()}")
        # print(f"3rd party: {media_pool_item.GetThirdPartyMetadata()}")
        print(f"Audio mapping: {media_pool_item.GetAudioMapping()}")
        # print(f"Track count: {timeline_item['bmd_item'].GetTrackCount("video")}")
        return None
    file_path_uuid: str = misc_utils.uuid_from_path(filepath).hex
    source_media_item: FileSource = {
        "file_path": filepath,
        "uuid": file_path_uuid,
        "bmd_media_pool_item": media_pool_item,
    }
    return source_media_item


def get_items_by_tracktype(
    track_type: Literal["video", "audio"], timeline: Any
) -> list[TimelineItem]:
    items: list[TimelineItem] = []
    track_count = timeline.GetTrackCount(track_type)
    for i in range(1, track_count + 1):
        track_items = timeline.GetItemListInTrack(track_type, i)
        for item in track_items:
            properties = item.GetProperty()
            pprint(f"Track {i} {track_type} item properties: {properties}")
            start_frame = item.GetStart(True)
            item_name = item.GetName()
            media_pool_item = item.GetMediaPoolItem()
            left_offset = item.GetLeftOffset(True)
            duration = item.GetDuration(True)
            source_start_float = left_offset
            source_end_float = left_offset + duration

            source_file_path: str = (
                media_pool_item.GetClipProperty("File Path") if media_pool_item else ""
            )
            timeline_item: TimelineItem = {
                "bmd_item": item,
                "duration": 0,  # unused, therefore 0 #item.GetDuration(),
                "name": item_name,
                "edit_instructions": [],
                "start_frame": start_frame,
                "end_frame": item.GetEnd(True),
                "id": get_item_id(item, item_name, start_frame, track_type, i),
                "track_type": track_type,
                "track_index": i,
                "source_file_path": source_file_path,
                "processed_file_name": misc_utils.uuid_from_path(source_file_path).hex,
                "source_start_frame": source_start_float,
                "source_end_frame": source_end_float,
            }
            items.append(timeline_item)
    return items


def main() -> None:
    global RESOLVE
    script_start_time: float = time()
    if not RESOLVE:
        print("Could not connect to DaVinci Resolve. Is it running?")
        # GetResolve already prints detailed errors if loading DaVinciResolveScript fails
        sys.exit(1)

    switch_to_page("edit")
    project = RESOLVE.GetProjectManager().GetCurrentProject()
    if not project:
        print("No project is currently open.")
        sys.exit(1)

    timeline = project.GetCurrentTimeline()
    if not timeline:
        print("No timeline is currently open.")
        sys.exit(1)

    timeline_name = timeline.GetName()
    timeline_fps = timeline.GetSetting("timelineFrameRate")
    current_file_path = os.path.dirname(os.path.abspath(__file__))
    
    pprint(get_items_by_tracktype("audio", timeline))
    return

    media_pool = project.GetMediaPool()
    mp_current_folder = media_pool.GetCurrentFolder()
    print(mp_current_folder.GetName())

    dup_clip_name = "P1466663.MOV"
    duplicated_clip = None
    for clip in mp_current_folder.GetClipList():
        if clip.GetName() == dup_clip_name:
            duplicated_clip = clip
            break
    if not duplicated_clip:
        print(f"Clip {dup_clip_name} not found.")
        return
    print(duplicated_clip.GetClipProperty("File Path"))
    pprint(duplicated_clip.GetClipProperty())
    

    for clip in timeline.GetItemListInTrack("video", 1):
        print(clip.GetProperty())
        break


    subfolders = mp_current_folder.GetSubFolderList()
    target_clip = None
    target_folder = None
    for folder in subfolders:
        print(folder.GetName())
        for clip in folder.GetClipList():
            if clip.GetName() == dup_clip_name:
                print(f"Found clip with same name {dup_clip_name} in folder {folder.GetName()}")
                target_clip = clip
                target_folder = folder
                break
    
    # relink
    media_pool.RelinkClips([duplicated_clip], [target_clip], target_folder)
    
    
    


def get_item_id(
    item: Any, item_name: str, start_frame: float, track_type: str, track_index: int
) -> str:
    return f"{item_name}-{track_type}-{track_index}--{start_frame}"


def make_edit_timeline(project_data: ProjectData, project) -> None:
    global RESOLVE
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

    # switch_to_page("edit")
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
        print(f"Warning: _recursive_find_item_in_folder received a None folder.")
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


def find_item_folder_by_id(project, item_id: str) -> Any | None:
    """
    Finds the Media Pool Folder object that contains a MediaPoolItem (e.g., timeline, clip)
    with the specified unique ID. Scans recursively.

    Args:
        item_id: The unique ID string of the MediaPoolItem to find.

    Returns:
        The Folder object containing the item if found, otherwise None.
        Returns None if RESOLVE object is not available or no project is open.
    """
    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()

    if not root_folder:
        print("Error: Could not get the root folder from the Media Pool.")
        return None

    print(
        f"Starting search for item ID '{item_id}' from root folder '{root_folder.GetName()}'."
    )
    return _recursive_find_item_in_folder(root_folder, item_id)


if __name__ == "__main__":
    script_time = time()
    main()
    script_end_time = time()
    script_execution_time = script_end_time - script_time
    print(f"Script finished successfully in {script_execution_time:.2f} seconds.")
