from typing import Any, Dict, Optional, Set, TypedDict

from local_types import ProjectData


# Define the structure for your mapping
class MediaPoolItemFolderMapping(TypedDict):
    media_pool_name: str  # Name of the MediaPoolItem
    file_path: str  # File path of the media on disk
    bmd_media_pool_item: Any  # The DaVinci Resolve MediaPoolItem object
    bmd_folder: Any  # The DaVinci Resolve Folder object (parent folder)


def _recursive_folder_scan(
    current_folder: Any,
    item_folder_map: Dict[str, MediaPoolItemFolderMapping],
    relevant_media_ids: Set[str],  # Changed: Set of MediaIDs from project_data
) -> None:
    """
    Helper function to recursively scan folders and populate the map.
    Only items whose MediaID is present in relevant_media_ids will be mapped.

    Args:
        current_folder: The DaVinci Resolve Folder object to scan.
        item_folder_map: The dictionary to populate with mappings.
        relevant_media_ids: A set of MediaIDs (strings) for items that should be mapped.
    """
    if not current_folder:
        return

    clips = current_folder.GetClipList()
    if clips:
        for item in clips:
            if not item:
                continue

            item_media_id = item.GetMediaId()

            # --- MODIFICATION ---
            # Filter: Only process items whose MediaID is in the relevant_media_ids set.
            # Also, ensure the item_media_id is valid before checking.
            if not item_media_id or item_media_id not in relevant_media_ids:
                continue
            # --- END MODIFICATION ---

            # At this point, item_media_id is a valid string and is relevant.
            # This item_media_id will be used as the key in item_folder_map.

            properties = item.GetClipProperty()
            file_path_value = ""
            possible_path_keys = [
                "File Path",
                "Path",
                "Full Path",
                "Filepath",
                "Media Path",
                "Proxy Path"
                if isinstance(properties, dict) and properties.get("Proxy") == "On"
                else None,
            ]
            possible_path_keys = [key for key in possible_path_keys if key is not None]

            if isinstance(properties, dict):
                for key in possible_path_keys:
                    if key in properties and properties[key]:
                        file_path_value = properties[key]
                        break

            if not isinstance(file_path_value, str):
                file_path_value = str(file_path_value)

            mapping: MediaPoolItemFolderMapping = {
                "media_pool_name": item.GetName(),
                "file_path": file_path_value,
                "bmd_media_pool_item": item,  # Store the actual object in the mapping
                "bmd_folder": current_folder,
            }
            # Use the MediaID (which is confirmed to be relevant) as the key for the map.
            item_folder_map[item_media_id] = mapping

    sub_folders = current_folder.GetSubFolderList()
    if sub_folders:
        for sub_folder in sub_folders:
            if sub_folder:
                _recursive_folder_scan(sub_folder, item_folder_map, relevant_media_ids)


def map_media_pool_items_to_folders(
    project: Any,
    project_data: ProjectData,
    start_folder: Optional[Any] = None,
) -> Dict[str, MediaPoolItemFolderMapping]:
    """
    Maps MediaPoolItems to their parent Folders in DaVinci Resolve, but only for items
    whose MediaID is referenced in the provided project_data.

    Args:
        project: The current DaVinci Resolve Project object.
        project_data: An object containing project information.
        start_folder: Optional. The DaVinci Resolve Folder object to start scanning from.

    Returns:
        A dictionary where keys are MediaPoolItem MediaIDs (strings)
        and values are MediaPoolItemFolderMapping TypedDicts for the relevant items.
    """
    item_folder_map: Dict[str, MediaPoolItemFolderMapping] = {}

    if not project:
        print("Error: Project object is None.")
        return item_folder_map

    if not project_data or not isinstance(project_data.get("files"), dict):
        print(
            "Error: project_data is missing or 'files' attribute is not a valid dictionary. No items will be mapped."
        )
        return item_folder_map

    # --- MODIFICATION START ---
    # Collect MediaIDs of relevant items from project_data
    relevant_media_ids: Set[str] = set()
    items_in_project_data_count = 0
    items_with_valid_media_id_count = 0

    for file_key, file_info in project_data["files"].items():
        items_in_project_data_count += 1
        if (
            isinstance(file_info, dict)
            and isinstance(file_info.get("fileSource"), dict)
            and "bmd_media_pool_item" in file_info["fileSource"]
        ):
            bmd_item = file_info["fileSource"]["bmd_media_pool_item"]
            # check if bmd_item is str "<BMDObject>"
            if bmd_item is not None:
                try:
                    media_id = bmd_item.GetMediaId()
                    if media_id and isinstance(
                        media_id, str
                    ):  # Ensure it's a non-empty string
                        relevant_media_ids.add(media_id)
                        items_with_valid_media_id_count += 1
                    else:
                        item_name = (
                            bmd_item.GetName()
                            if hasattr(bmd_item, "GetName")
                            else "Unknown Name"
                        )
                        print(
                            f"Warning: Media item (name: '{item_name}', from project_data key: '{file_key}') is missing a valid MediaId. It cannot be tracked for folder mapping by ID."
                        )
                except Exception as e:
                    item_name = (
                        bmd_item.GetName()
                        if hasattr(bmd_item, "GetName")
                        else "Unknown Name"
                    )
                    print(
                        f"Warning: Error getting MediaId for item (name: '{item_name}', from project_data key: '{file_key}'): {e}. It will be skipped."
                    )
            else:
                print(
                    f"Warning: 'bmd_media_pool_item' is None for project_data key: '{file_key}'."
                )
        else:
            print(
                f"Warning: Malformed file_info or missing 'fileSource'/'bmd_media_pool_item' for project_data key: '{file_key}'."
            )

    print(f"Processed {items_in_project_data_count} file entries from project_data.")
    if not relevant_media_ids:
        print(
            "No relevant media items (with valid MediaIDs) found in project_data. The map will be empty."
        )
        return item_folder_map
    print(
        f"Found {len(relevant_media_ids)} unique relevant MediaIDs to scan for in the Media Pool."
    )
    # --- MODIFICATION END ---

    media_pool = project.GetMediaPool()
    if not media_pool:
        print("Error: Could not get Media Pool from Project.")
        return item_folder_map

    folder_to_scan = start_folder
    if folder_to_scan is None:
        folder_to_scan = media_pool.GetRootFolder()
        if not folder_to_scan:
            print("Error: Could not get Root Folder from Media Pool.")
            return item_folder_map

    print(f"Starting scan from folder: '{folder_to_scan.GetName()}'.")
    _recursive_folder_scan(folder_to_scan, item_folder_map, relevant_media_ids)

    print(f"Finished scan. Mapped {len(item_folder_map)} items to their folders.")
    return item_folder_map


def _get_or_create_media_pool_folder(
    media_pool: Any, parent_folder: Any, folder_name: str
) -> Optional[Any]:
    if not media_pool or not parent_folder:
        print("Error: MediaPool or Parent Folder object is None.")
        return None
    new_folder = media_pool.AddSubFolder(parent_folder, folder_name)
    if new_folder:
        print(f"Successfully created folder: '{folder_name}'.")
        return new_folder
    else:
        # Fallback check if AddSubFolder returned None but folder might exist
        sub_folders_after_add = parent_folder.GetSubFolderList()
        if sub_folders_after_add:
            for folder_obj in sub_folders_after_add:
                if folder_obj and folder_obj.GetName() == folder_name:
                    print(f"Re-fetched and confirmed folder: '{folder_name}'.")
                    return folder_obj
        print(f"Error: Failed to create or find folder: '{folder_name}'.")
        return None


# --- Function to move clips to a temporary folder (Simplified return logic) ---
def move_clips_to_temp_folder(
    project: Any,
    item_folder_map: dict[str, MediaPoolItemFolderMapping],
    temp_folder_name: str = "TEMP_CLIP_HOLDER",
    max_retries: int = 3,
) -> Optional[Any]:
    """
    Moves MediaPoolItems from the item_folder_map into a specified temporary folder.
    The temporary folder will be created under the Media Pool's root folder if it doesn't exist.
    Returns the temporary folder object if found/created, None only if folder ops fail.
    Logs warnings if MoveClips API reports issues but still returns folder object.
    """
    if not project:
        print("Error: Project object is None.")
        return None
    media_pool = project.GetMediaPool()
    if not media_pool:
        print("Error: Could not get Media Pool from Project.")
        return None
    root_folder = media_pool.GetRootFolder()
    if not root_folder:
        print("Error: Could not get Root Folder from Media Pool.")
        return None

    temp_folder = _get_or_create_media_pool_folder(
        media_pool, root_folder, temp_folder_name
    )
    if not temp_folder:  # Critical failure to get/create the folder itself
        print(f"Error: Could not get or create temporary folder '{temp_folder_name}'.")
        return None

    print(
        f"Moving clips to temporary folder: '{temp_folder.GetName()}'"
    )  # <- THIS IS ACTUALLY NECESSARY
    # OTHERWISE THERE COULD BE A RACE CONDITION
    # WHERE CLIPS ARE NOT MOVED BUT COPIED
    # WHICH TAKES FOREVER
    # time.sleep(0.1)

    clips_no_filepaths = []
    clips_filepaths = []
    for item in item_folder_map.values():
        bmd_mp_item = item["bmd_media_pool_item"]
        if not bmd_mp_item:
            continue

        media_id_to_store = bmd_mp_item.GetMediaId()

        if media_id_to_store:
            success = bmd_mp_item.SetThirdPartyMetadata(
                {"silence_detect_uuid": media_id_to_store}
            )
            if success:
                print(
                    f"Set metadata for '{bmd_mp_item.GetName()}' with MediaID: {media_id_to_store}"
                )
            else:
                print(
                    f"Warning: Failed to set metadata for clip '{bmd_mp_item.GetName()}' (MediaID: {media_id_to_store})"
                )
        else:
            print(
                f"Warning: Clip '{bmd_mp_item.GetName()}' has no MediaID at metadata setting time. Skipping metadata set."
            )

        if not item["file_path"]:
            clips_no_filepaths.append(item["bmd_media_pool_item"])
        else:
            clips_filepaths.append(item["bmd_media_pool_item"])

    success_filepaths = media_pool.MoveClips(clips_filepaths, temp_folder)
    success_no_filepaths = media_pool.MoveClips(clips_no_filepaths, temp_folder)

    if not success_no_filepaths and not success_filepaths:
        print(f"Move operation failed after {max_retries} attempts.")
        raise Exception("Move operation failed after {max_retries} attempts.")

    # check if one of the item is still in the original folder
    for item in item_folder_map.values():
        folder_to_check = item["bmd_folder"]
        if not folder_to_check:
            continue
        clips_in_folder = folder_to_check.GetClipList()
        if not clips_in_folder:
            # success
            break
        if item["bmd_media_pool_item"] in clips_in_folder:
            print(
                f"Item '{item['bmd_media_pool_item'].GetName()}' is still in the original folder."
            )
            raise Exception(
                f"Item '{item['bmd_media_pool_item'].GetName()}' is still in the original folder."
            )

    # # add the media ids to third party metadata
    # for item in clips_filepaths:
    #     item.SetThirdPartyMetadata({"silence_detect_uuid": item.GetMediaId()})
    # for item in clips_no_filepaths:
    #     item.SetThirdPartyMetadata({"silence_detect_uuid": item.GetMediaId()})

    return temp_folder


# --- Function to restore clips from the temporary folder (Simplified and Unconditional Delete) ---
def restore_clips_from_temp_folder(
    project: Any,
    item_folder_map: dict[str, MediaPoolItemFolderMapping],
    temp_folder: Any,  # The DaVinci Resolve Folder object for the temporary folder
) -> bool:
    """
    Attempts to move MediaPoolItems from the temporary folder back to their original folders
    in batches, based on item_folder_map. Then, unconditionally deletes the temporary folder.
    Prioritizes speed and simplicity, logs warnings for anomalies but proceeds.

    Args:
        project: The current DaVinci Resolve Project object.
        item_folder_map: The dictionary mapping MediaItem IDs to their original folder details.
        temp_folder: The DaVinci Resolve Folder object of the temporary folder.

    Returns:
        True if the temporary folder was successfully deleted, False otherwise.
    """
    if not project:
        print("Error: Project object is None.")
        return False  # Cannot proceed
    if not temp_folder:
        print("Error: Temporary folder object is None.")
        return False  # Cannot proceed

    media_pool = project.GetMediaPool()
    if not media_pool:
        print("Error: Could not get Media Pool from Project.")
        return False  # Cannot proceed

    clips_in_temp_folder = temp_folder.GetClipList()
    clips_by_original_folder_data: dict[str, dict[str, Any]] = {}

    if not clips_in_temp_folder:
        print("No clips found in temporary folder.")
        return False

    print(
        f"Processing {len(clips_in_temp_folder)} clips found in temporary folder for restoration."
    )
    for clip in clips_in_temp_folder:
        if not clip:
            continue  # Should not happen in a valid list

        bmd_media_id = clip.GetMediaId()
        metadata = clip.GetThirdPartyMetadata()
        if not metadata and not bmd_media_id:
            raise Exception(f"Clip '{clip.GetName()}' has no media id.")
        # print(f"Clip '{clip.GetName()}' has metadata: {metadata}")
        media_id = metadata.get("silence_detect_uuid") or bmd_media_id

        if not media_id:
            raise Exception(f"Clip '{clip.GetName()}' has no metadata.")

        if media_id in item_folder_map:
            original_folder_info = item_folder_map[media_id]
            original_folder_obj = original_folder_info.get("bmd_folder")

            if original_folder_obj:
                original_folder_id = original_folder_obj.GetUniqueId()
                if original_folder_id:
                    if original_folder_id not in clips_by_original_folder_data:
                        clips_by_original_folder_data[original_folder_id] = {
                            "folder_obj": original_folder_obj,
                            "clips": [],
                        }
                    clips_by_original_folder_data[original_folder_id]["clips"].append(
                        clip
                    )
                else:
                    print(
                        f"Warning: Could not get Unique ID for original folder of clip '{clip.GetName()}' (ID: {media_id}). It will be deleted with the temp folder."
                    )
            else:
                print(
                    f"Warning: Original folder not specified in map for clip '{clip.GetName()}' (ID: {media_id}). It will be deleted with the temp folder."
                )
                raise Exception(f"Clip '{clip.GetName()}' has no original folder.")
        else:
            print(
                f"Info: Clip '{clip.GetName()}' (ID: {media_id}) in temp folder is not in the restoration map. It will be deleted with the temp folder."
            )
            raise Exception(
                f"Clip '{clip.GetName()}' (ID: {media_id}) in temp folder is not in the restoration map."
            )
            # get it from clip.GetThirdPartyMetadata()

    else:
        print(f"No clips found in temporary folder.")

    # Attempt to move mapped clips back
    if clips_by_original_folder_data:
        print(
            f"Attempting to restore mapped clips in {len(clips_by_original_folder_data)} batches..."
        )
        for folder_id, data_for_folder in clips_by_original_folder_data.items():
            target_folder_obj = data_for_folder["folder_obj"]
            clips_list = data_for_folder["clips"]

            if clips_list:
                print(
                    f"  Moving {len(clips_list)} clips to folder '{target_folder_obj.GetName()}' (ID: {folder_id})..."
                )
                if not media_pool.MoveClips(clips_list, target_folder_obj):
                    print(
                        f"    Warning: API reported failure for batch move to '{target_folder_obj.GetName()}'. Clips might not have moved as expected."
                    )
                else:
                    print(
                        f"    API reported success for batch move to '{target_folder_obj.GetName()}'."
                    )
    else:
        if clips_in_temp_folder:  # Clips were present, but none were in the map.
            print("No clips in the temp folder were found in the restoration map.")
        # If clips_in_temp_folder was empty, the "No clips found" message from above suffices.

    # Unconditionally delete the temp folder
    print("Proceeding to delete temporary folder...")
    delete_success = media_pool.DeleteFolders([temp_folder])

    if delete_success:
        print("Successfully deleted temporary folder.")
    else:
        print(f"ERROR: Failed to delete temporary folder '{temp_folder.GetName()}'.")

    return delete_success
