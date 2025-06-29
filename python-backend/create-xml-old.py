#!/usr/bin/env python3

import xml.etree.ElementTree as ET
from urllib.parse import unquote
import math
import copy
import json
import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set, Any, cast, Union
from xml.etree.ElementTree import Element

# --- Type Definitions ---
ClipSegmentData = Dict[str, Any]  # Simplified for broader use
SilenceInterval = Dict[str, float]
SilenceData = Dict[str, List[SilenceInterval]]
ProjectData = Tuple[Dict[str, ET.Element], Dict[str, ET.Element], Dict[str, Set[str]]]


# --- Helper Functions ---
def get_element_value(
    element: ET.Element, path: str, default: Optional[str] = None
) -> Optional[str]:
    """Safely get text value from a child element specified by path."""
    found = element.find(path)
    return found.text if found is not None and found.text is not None else default


def get_element_attr(
    element: ET.Element, path: str, attr: str, default: Optional[str] = None
) -> Optional[str]:
    """Safely get an attribute value from a child element specified by path."""
    found = element.find(path)
    return found.get(attr) if found is not None else default


def get_source_info(
    file_element: ET.Element,
) -> Tuple[Optional[str], Optional[float], Optional[int]]:
    """
    Extracts source file path, frame rate (fps), and duration from a <file> element.
    Returns: Tuple (path_url, fps, duration_frames) or (None, None, None) if info is missing.
    """
    pathurl_el = file_element.find("./pathurl")
    rate_el = file_element.find("./rate/timebase")
    duration_el = file_element.find("./duration")

    pathurl: Optional[str] = (
        pathurl_el.text
        if pathurl_el is not None and pathurl_el.text is not None
        else None
    )
    fps: Optional[float] = None
    duration: Optional[int] = None

    # Remove 'file://' prefix if present and normalize path slightly
    if pathurl:
        # 1. Remove 'file://' prefix
        if pathurl.startswith("file://"):
            pathurl = pathurl[len("file://") :]
        # 2. Decode URL encoding (e.g., %20 -> space)
        pathurl = unquote(string=pathurl)  #
        print(f"Decoded pathurl: {pathurl}")

    if rate_el is not None and rate_el.text is not None:
        try:
            fps = float(rate_el.text)
            if fps <= 0:
                print(
                    f"Warning: Invalid FPS value {fps} in file element.",
                    file=sys.stderr,
                )
                fps = None
        except ValueError:
            print(
                f"Warning: Non-numeric FPS value '{rate_el.text}' in file element.",
                file=sys.stderr,
            )
            fps = None

    if duration_el is not None and duration_el.text is not None:
        try:
            duration = int(duration_el.text)
        except ValueError:
            print(
                f"Warning: Non-numeric duration value '{duration_el.text}' in file element.",
                file=sys.stderr,
            )
            duration = None

    return pathurl, fps, duration


def convert_seconds_to_frames(seconds: float, fps: float) -> int:
    """Converts time in seconds to frame number using ceiling."""
    if fps <= 0:
        # This case should ideally be handled before calling, but added as safety
        print(
            f"Error: Invalid FPS {fps} for time-to-frame conversion.", file=sys.stderr
        )
        raise ValueError("FPS must be positive")
    return int(math.ceil(seconds * fps))


def generate_unique_clip_id(original_id: str, segment_index: int) -> str:
    if not original_id:
        original_id = f"clip_{segment_index}"
    clean_base = original_id.replace(".", "_").replace(" ", "_")
    while "__" in clean_base:
        clean_base = clean_base.replace("__", "_")
    return f"{clean_base}_seg_{segment_index}"


def add_doctype(filepath: Path) -> None:
    """Prepends the FCP XMEML DOCTYPE to the XML file."""
    try:
        with open(filepath, "r+") as f:
            content = f.read()
            f.seek(0, 0)
            # Find the position after the XML declaration
            declaration_end = (
                content.find("?>") + 2 if content.startswith("<?xml") else 0
            )
            doctype = "<!DOCTYPE xmeml>\n"  # Basic FCP XMEML doctype
            # Add newline after declaration if needed
            prefix = content[:declaration_end]
            if declaration_end > 0 and not prefix.endswith("\n"):
                prefix += "\n"

            f.write(
                prefix + doctype + content[declaration_end:].lstrip()
            )  # lstrip to remove potential extra space
        print(f"Added DOCTYPE declaration to {filepath}.")
    except IOError as e:
        print(f"Error adding DOCTYPE to {filepath}: {e}", file=sys.stderr)
    except Exception as e:  # Catch other potential errors during file manipulation
        print(f"Unexpected error adding DOCTYPE to {filepath}: {e}", file=sys.stderr)


def build_project_data(root: ET.Element, all_tracks: List[ET.Element]) -> ProjectData:
    """Parses root and tracks to build file, clipitem, and link lookups."""
    # Build file_elements (ensuring definitions are stored)
    file_elements: Dict[str, ET.Element] = {}
    print("Scanning for file definitions...")
    all_found_files = root.findall(".//file[@id]")
    print(f"Found {len(all_found_files)} total <file> elements with IDs.")
    for file_el in all_found_files:
        file_id = file_el.get("id")
        if file_id:
            if file_id not in file_elements:
                if (
                    file_el.find("pathurl") is not None
                    or file_el.find("media") is not None
                ):
                    file_elements[file_id] = file_el
    print(f"Stored definitions for {len(file_elements)} unique file IDs.")

    linked_clips_map: Dict[str, Set[str]] = {}
    clipitem_elements: Dict[str, ET.Element] = {}
    print("Building initial clipitem map and links...")
    for track in all_tracks:
        for clipitem in track.findall("clipitem"):
            clip_id = clipitem.get("id")
            if not clip_id:
                print(
                    f"Warning: Clipitem missing ID. Name: {get_element_value(clipitem, 'name', 'N/A')}",
                    file=sys.stderr,
                )
                continue
            clipitem_elements[clip_id] = clipitem

            partner_ids: Set[str] = set()
            for link in clipitem.findall("link"):
                linkclipref = link.find("linkclipref")
                if (
                    linkclipref is not None
                    and linkclipref.text
                    and linkclipref.text != clip_id
                ):
                    partner_ids.add(linkclipref.text)

            if partner_ids:
                if clip_id not in linked_clips_map:
                    linked_clips_map[clip_id] = set()
                linked_clips_map[clip_id].update(partner_ids)

    print(f"Found {len(clipitem_elements)} clipitems with IDs.")
    return file_elements, clipitem_elements, linked_clips_map


def recreate_segments_from_partner(
    clipitem_template: ET.Element,
    original_clip_id: Optional[str],
    clip_name: Optional[str],
    partner_processing_result: List[ClipSegmentData],
    linked_clips_map: Dict[str, Set[str]],
) -> Tuple[List[ET.Element], List[ClipSegmentData]]:
    """Creates new clipitem elements based on a linked partner's segment data."""
    recreated_segments: List[ET.Element] = []
    current_clip_new_segments_data: List[ClipSegmentData] = []
    success = True

    for i, segment_data in enumerate(partner_processing_result):
        if not all(k in segment_data for k in ["new_id", "start", "end", "in", "out"]):
            print(
                f"    Error: Partner segment data missing keys. Skipping recreation.",
                file=sys.stderr,
            )
            success = False
            break  # Stop trying to recreate for this clip

        new_segment = copy.deepcopy(clipitem_template)
        new_segment_id = generate_unique_clip_id(
            original_clip_id if original_clip_id else clip_name or "linked_clip", i
        )
        new_segment.set("id", new_segment_id)

        # Safely access data
        seg_start = cast(int, segment_data["start"])
        seg_end = cast(int, segment_data["end"])
        seg_in = cast(int, segment_data["in"])
        seg_out = cast(int, segment_data["out"])
        partner_new_id = cast(str, segment_data["new_id"])

        start_el = new_segment.find("start")
        end_el = new_segment.find("end")
        in_el = new_segment.find("in")
        out_el = new_segment.find("out")
        dur_el: Element[str] | None = new_segment.find("duration")

        if not (
            start_el is not None
            and end_el is not None
            and in_el is not None
            and out_el is not None
        ):
            print(
                f"    Error: Cannot find time elements in copied segment {new_segment_id}. Skipping recreation.",
                file=sys.stderr,
            )
            success = False
            break

        start_el.text = str(seg_start)
        end_el.text = str(seg_end)
        in_el.text = str(seg_in)
        out_el.text = str(seg_out)
        timeline_duration = seg_end - seg_start
        if dur_el is not None:
            dur_el.text = str(timeline_duration)

        # Update links (preliminary update - post-processing ensures full correctness)
        for link in new_segment.findall(".//link"):
            linkclipref = link.find("linkclipref")
            if linkclipref is not None:
                # Check if the original text pointed to a known partner
                original_partners = linked_clips_map.get(original_clip_id or "", set())
                if linkclipref.text in original_partners:
                    linkclipref.text = (
                        partner_new_id  # Point to the *partner's* new segment ID
                    )
                elif linkclipref.text == original_clip_id:
                    linkclipref.text = new_segment_id  # Point to self

        # Update filter/effect durations
        source_duration = seg_out - seg_in
        for effect_start in new_segment.findall(".//filter/start"):
            effect_start.text = "0"
        for effect_end in new_segment.findall(".//filter/end"):
            # FCP/Resolve often uses source duration/frames for effect end? Let's stick to that.
            # Alternatively, use timeline_duration if effects are timeline-based. Test needed.
            effect_end.text = str(source_duration)

        recreated_segments.append(new_segment)
        current_clip_new_segments_data.append(
            {
                "original_id": original_clip_id,
                "new_id": new_segment_id,
                "start": seg_start,
                "end": seg_end,
                "in": seg_in,
                "out": seg_out,
            }
        )

    if not success:
        # If recreation failed, return the original template element and no data
        return [clipitem_template], []

    return recreated_segments, current_clip_new_segments_data


def calculate_non_silent_segments(
    clip_in_source: int,
    clip_out_source: int,
    source_fps: float,
    silence_intervals_sec: List[SilenceInterval],
    current_timeline_position: int,
) -> Tuple[List[Dict[str, int]], int]:
    """Calculates non-silent segment boundaries in source and timeline frames."""
    calculated_segments: List[Dict[str, int]] = []
    silences_in_frames: List[Dict[str, int]] = []
    relevant_silences_found = False

    for silence in silence_intervals_sec:
        if not ("start" in silence and "end" in silence):
            continue
        try:
            start_sec = float(silence["start"])
            end_sec = float(silence["end"])
            start_frame = convert_seconds_to_frames(start_sec, source_fps)
            end_frame = convert_seconds_to_frames(end_sec, source_fps)
        except (ValueError, TypeError):
            continue

        overlap_start = max(clip_in_source, start_frame)
        overlap_end = min(clip_out_source, end_frame)

        if overlap_end > overlap_start:
            silences_in_frames.append({"start": overlap_start, "end": overlap_end})
            relevant_silences_found = True

    if not relevant_silences_found:
        # No relevant silences, the only "segment" is the original range
        duration = clip_out_source - clip_in_source
        if duration > 0:
            calculated_segments.append(
                {
                    "in": clip_in_source,
                    "out": clip_out_source,
                    "start": current_timeline_position,
                    "end": current_timeline_position + duration,
                    "duration": duration,
                }
            )
            current_timeline_position += duration
        return (
            calculated_segments,
            current_timeline_position,
        )  # Return original segment data & new position

    # Found silences, calculate segments between them
    print(f"Found {len(silences_in_frames)} relevant silence intervals for this clip.")
    silences_in_frames.sort(key=lambda x: x["start"])

    current_source_marker = clip_in_source
    temp_current_timeline_pos = current_timeline_position

    for silence in silences_in_frames:
        silence_start = silence["start"]
        silence_end = silence["end"]

        if silence_start > current_source_marker:
            segment_in = current_source_marker
            segment_out = silence_start
            segment_duration = segment_out - segment_in
            segment_timeline_start = temp_current_timeline_pos
            segment_timeline_end = temp_current_timeline_pos + segment_duration
            calculated_segments.append(
                {
                    "in": segment_in,
                    "out": segment_out,
                    "start": segment_timeline_start,
                    "end": segment_timeline_end,
                    "duration": segment_duration,
                }
            )
            temp_current_timeline_pos += segment_duration

        current_source_marker = max(current_source_marker, silence_end)

    if current_source_marker < clip_out_source:
        segment_in = current_source_marker
        segment_out = clip_out_source
        segment_duration = segment_out - segment_in
        segment_timeline_start = temp_current_timeline_pos
        segment_timeline_end = temp_current_timeline_pos + segment_duration
        calculated_segments.append(
            {
                "in": segment_in,
                "out": segment_out,
                "start": segment_timeline_start,
                "end": segment_timeline_end,
                "duration": segment_duration,
            }
        )
        temp_current_timeline_pos += segment_duration

    return calculated_segments, temp_current_timeline_pos


def create_clip_segments_from_data(
    clipitem_template: ET.Element,
    original_clip_id: Optional[str],
    clip_name: Optional[str],
    calculated_segments: List[Dict[str, int]],
) -> Tuple[List[ET.Element], List[ClipSegmentData]]:
    """Creates new clipitem ET.Elements based on calculated segment data."""
    new_segments_created: List[ET.Element] = []
    current_clip_new_segments_data: List[ClipSegmentData] = []
    success = True

    print(
        f"    Splitting clip '{clip_name or original_clip_id}' into {len(calculated_segments)} segments."
    )
    for i, seg_data in enumerate(calculated_segments):
        new_clip = copy.deepcopy(clipitem_template)
        new_clip_id = generate_unique_clip_id(
            original_clip_id if original_clip_id else clip_name or "segment", i
        )
        new_clip.set("id", new_clip_id)

        start_el = new_clip.find("start")
        end_el = new_clip.find("end")
        in_el = new_clip.find("in")
        out_el = new_clip.find("out")
        dur_el = new_clip.find("duration")

        if not (
            start_el is not None
            and end_el is not None
            and in_el is not None
            and out_el is not None
        ):
            print(
                f"    Error: Cannot find time elements in copied segment for {new_clip_id}. Aborting split.",
                file=sys.stderr,
            )
            success = False
            break

        seg_start = seg_data["start"]
        seg_end = seg_data["end"]
        seg_in = seg_data["in"]
        seg_out = seg_data["out"]
        seg_duration = seg_data["duration"]  # Source duration

        start_el.text = str(seg_start)
        end_el.text = str(seg_end)
        in_el.text = str(seg_in)
        out_el.text = str(seg_out)
        if dur_el is not None:
            dur_el.text = str(seg_end - seg_start)  # Timeline duration

        # Update self-referencing link
        for link in new_clip.findall(".//link"):
            linkclipref = link.find("linkclipref")
            if linkclipref is not None and linkclipref.text == original_clip_id:
                linkclipref.text = new_clip_id

        # Update filter/effect end times
        for effect_end in new_clip.findall(".//filter/end"):
            effect_end.text = str(seg_duration)  # Use source duration
        for effect_start in new_clip.findall(".//filter/start"):
            effect_start.text = "0"

        new_segments_created.append(new_clip)
        current_clip_new_segments_data.append(
            {
                "original_id": original_clip_id,
                "new_id": new_clip_id,
                "start": seg_start,
                "end": seg_end,
                "in": seg_in,
                "out": seg_out,
            }
        )

    if not success:
        # Return the original template if creation failed
        return [clipitem_template], []

    return new_segments_created, current_clip_new_segments_data


def perform_silence_removal(
    clipitem: ET.Element,
    original_clip_id: Optional[str],
    clip_name: Optional[str],
    source_path: str,
    source_fps: float,
    clip_in_source: int,
    clip_out_source: int,
    current_timeline_position: int,
    silence_data: SilenceData,
) -> Tuple[List[ET.Element], List[ClipSegmentData], int]:
    """Handles silence removal logic for a single clip."""

    silence_intervals_sec = silence_data.get(source_path, [])
    if not silence_intervals_sec:
        print(
            f"    No silence intervals found for '{source_path}' in dictionary.",
            file=sys.stderr,
        )
        # Treat as if no silence removal needed, return original shifted clip data
        shifted_clip, shifted_data, next_pos = shift_clip_on_timeline(
            clipitem,
            original_clip_id,
            0,
            0,  # dummy start/end needed? No, use in/out
            clip_in_source,
            clip_out_source,
            current_timeline_position,
        )
        return [shifted_clip], shifted_data, next_pos

    calculated_segments, next_timeline_pos = calculate_non_silent_segments(
        clip_in_source,
        clip_out_source,
        source_fps,
        silence_intervals_sec,
        current_timeline_position,
    )

    if not calculated_segments:
        # Silences cover the entire clip range
        print(
            f"    Clip '{clip_name or original_clip_id}' removed completely due to silence."
        )
        return (
            [],
            [],
            current_timeline_position,
        )  # Return empty lists and original position

    if (
        len(calculated_segments) == 1
        and calculated_segments[0]["in"] == clip_in_source
        and calculated_segments[0]["out"] == clip_out_source
    ):
        # No effective cuts were made (silences outside used range)
        print(
            f"    No relevant silences within source range [{clip_in_source}-{clip_out_source}]. Shifting position."
        )
        shifted_clip, shifted_data, next_pos = shift_clip_on_timeline(
            clipitem,
            original_clip_id,
            clip_in_source,
            clip_out_source,
            current_timeline_position,
        )
        return [shifted_clip], shifted_data, next_pos

    # Create new elements from the calculated segments
    new_elements, new_segments_data = create_clip_segments_from_data(
        clipitem, original_clip_id, clip_name, calculated_segments
    )

    # If creation failed, create_clip_segments_from_data returns the original element
    if len(new_elements) == 1 and new_elements[0] is clipitem:
        print(
            "   Segment creation failed, shifting original clip instead.",
            file=sys.stderr,
        )
        shifted_clip, shifted_data, next_pos = shift_clip_on_timeline(
            clipitem,
            original_clip_id,
            clip_in_source,
            clip_out_source,
            current_timeline_position,
        )
        return [shifted_clip], shifted_data, next_pos

    return new_elements, new_segments_data, next_timeline_pos


def shift_clip_on_timeline(
    clipitem: ET.Element,
    original_clip_id: Optional[str],
    # clip_start_timeline: int, clip_end_timeline: int, # Use in/out to derive duration
    clip_in_source: int,
    clip_out_source: int,
    current_timeline_position: int,
) -> Tuple[ET.Element, List[ClipSegmentData], int]:
    """Updates the start/end of a clipitem and returns its new position and data."""
    start_el = clipitem.find("start")
    end_el = clipitem.find("end")

    if start_el is None or end_el is None:
        print(
            f"    Error: Cannot find start/end elements to shift clip '{get_element_value(clipitem, 'name', original_clip_id)}'. Skipping.",
            file=sys.stderr,
        )
        # Return unchanged position and empty data
        return clipitem, [], current_timeline_position

    # Duration calculation based on source in/out - assumes timeline uses source frames directly
    # If timeline rate differs significantly, this might need adjustment (rare in FCPXML?)
    source_duration = clip_out_source - clip_in_source
    if source_duration < 0:
        source_duration = 0  # Safety

    start_el.text = str(current_timeline_position)
    end_el.text = str(current_timeline_position + source_duration)
    next_pos = current_timeline_position + source_duration

    # Store data for potential linked clips
    segment_data = [
        {
            "original_id": original_clip_id,
            "new_id": original_clip_id,  # Use original ID
            "start": current_timeline_position,
            "end": next_pos,
            "in": clip_in_source,
            "out": clip_out_source,
        }
    ]

    return clipitem, segment_data, next_pos


def process_single_clipitem(
    clipitem: ET.Element,
    current_timeline_position: int,
    file_elements: Dict[str, ET.Element],
    processed_clips_data: Dict[str, List[ClipSegmentData]],
    linked_clips_map: Dict[str, Set[str]],
    silence_data: SilenceData,
) -> Tuple[List[ET.Element], List[ClipSegmentData], int]:
    """Processes one clipitem, returning new elements, their data, and next timeline position."""

    clip_id = clipitem.get("id")
    name = get_element_value(clipitem, "name", "Unknown Clip")

    try:
        clip_in_source = int(get_element_value(clipitem, "in", "0") or "0")
        clip_out_source = int(get_element_value(clipitem, "out", "0") or "0")
    except ValueError:
        print(
            f"    Warning: Invalid in/out values for clip '{name}' (ID: {clip_id}). Skipping.",
            file=sys.stderr,
        )
        return [], [], current_timeline_position  # Return empty, unchanged position

    file_id = get_element_attr(clipitem, "file", "id")
    print(
        f"  Processing clip: '{name}' (ID: {clip_id}, Source: {clip_in_source}-{clip_out_source})"
    )

    segments_to_add: List[ET.Element] = [clipitem]  # Default: original clip
    current_clip_segments_data: List[ClipSegmentData] = []
    next_timeline_position = current_timeline_position  # Default: unchanged

    file_element: Optional[ET.Element] = None
    source_path: Optional[str] = None
    source_fps: Optional[float] = None

    if file_id and file_id in file_elements:
        file_element = file_elements.get(file_id)  # Use get for safety
        if file_element is not None:
            source_path, source_fps, _ = get_source_info(file_element)
        else:
            print(
                f"    Warning: File element for ID '{file_id}' not found in map.",
                file=sys.stderr,
            )
            file_id = None  # Treat as if no file element found
    else:
        print(
            f"    Warning: Clip '{name}' missing file reference ID '{file_id}'. Shifting position only."
        )
        file_id = None  # Ensure downstream logic knows file info is missing

    # --- Main Decision Logic ---
    if file_element is not None and source_path and source_fps:
        # 1. Check if linked partner was processed
        linked_partner_processed = False
        partner_processing_result: Optional[List[ClipSegmentData]] = None
        if clip_id and clip_id in linked_clips_map:
            for partner_id in linked_clips_map[clip_id]:
                if partner_id in processed_clips_data:
                    print(
                        f"    Clip '{clip_id}' linked to processed clip '{partner_id}'. Recreating segments."
                    )
                    partner_processing_result = processed_clips_data[partner_id]
                    linked_partner_processed = True
                    break

        if linked_partner_processed and partner_processing_result is not None:
            segments_to_add, current_clip_segments_data = (
                recreate_segments_from_partner(
                    clipitem, clip_id, name, partner_processing_result, linked_clips_map
                )
            )
            # Determine next timeline position from the last recreated segment
            if current_clip_segments_data:
                next_timeline_position = cast(
                    int, current_clip_segments_data[-1]["end"]
                )
            else:
                # Recreation failed, keep original position (clip wasn't added)
                next_timeline_position = current_timeline_position

        # 2. Perform silence removal if not handled by link
        elif source_path in silence_data:
            segments_to_add, current_clip_segments_data, next_timeline_position = (
                perform_silence_removal(
                    clipitem,
                    clip_id,
                    name,
                    source_path,
                    source_fps,
                    clip_in_source,
                    clip_out_source,
                    current_timeline_position,
                    silence_data,
                )
            )

        # 3. No silence data for this source path, just shift
        else:
            print(
                f"    No silence data provided for '{source_path}'. Shifting position."
            )
            shifted_clip, current_clip_segments_data, next_timeline_position = (
                shift_clip_on_timeline(
                    clipitem,
                    clip_id,
                    clip_in_source,
                    clip_out_source,
                    current_timeline_position,
                )
            )
            segments_to_add = [shifted_clip]

    # 4. File info was missing, just shift
    else:
        print(
            f"    Cannot process for silence due to missing file info. Shifting position."
        )
        shifted_clip, current_clip_segments_data, next_timeline_position = (
            shift_clip_on_timeline(
                clipitem,
                clip_id,
                clip_in_source,
                clip_out_source,
                current_timeline_position,
            )
        )
        segments_to_add = [shifted_clip]

    # --- Store processing results if segments were generated/shifted ---
    if clip_id and current_clip_segments_data:
        processed_clips_data[clip_id] = current_clip_segments_data
    elif clip_id and not segments_to_add:
        # Clip was processed and resulted in zero segments (completely removed)
        processed_clips_data[clip_id] = []  # Mark as processed but empty

    return segments_to_add, current_clip_segments_data, next_timeline_position


def process_track(
    track: ET.Element,
    track_idx: int,
    is_video_track: bool,
    file_elements: Dict[str, ET.Element],
    processed_clips_data: Dict[str, List[ClipSegmentData]],
    linked_clips_map: Dict[str, Set[str]],
    silence_data: SilenceData,
) -> int:
    """Processes all clipitems in a single track."""
    track_type = "Video" if is_video_track else "Audio"
    original_clipitems: List[ET.Element] = list(track.findall("clipitem"))
    if not original_clipitems:
        print(f"\nProcessing {track_type} Track {track_idx+1} (contains 0 clips)...")
        return 0  # No clips, duration impact is 0

    print(
        f"\nProcessing {track_type} Track {track_idx+1} (contains {len(original_clipitems)} clips)..."
    )

    # Clear existing clips before adding new ones
    for clip in original_clipitems:
        track.remove(clip)

    # Sort original clips by timeline start time
    original_clipitems.sort(
        key=lambda c: int(get_element_value(c, "start", "0") or "0")
    )

    new_clipitems_for_track: List[ET.Element] = []
    current_timeline_position: int = 0

    for clipitem in original_clipitems:
        # Process this clip
        new_elements, _, next_timeline_pos = process_single_clipitem(
            clipitem,
            current_timeline_position,
            file_elements,
            processed_clips_data,
            linked_clips_map,
            silence_data,
        )
        # Add the results to the list for this track
        new_clipitems_for_track.extend(new_elements)
        # Update the timeline cursor for the next clip
        current_timeline_position = next_timeline_pos

    # Add all new/shifted clips back to the track element in the XML tree
    for item in new_clipitems_for_track:
        track.append(item)

    # Return the final timeline position for this track
    return current_timeline_position


def update_all_segment_links(
    all_tracks: List[ET.Element],
    processed_clips_data: Dict[str, List[ClipSegmentData]],
    linked_clips_map: Dict[str, Set[str]],
    clipitem_elements: Dict[str, ET.Element],
) -> None:
    """Post-processing step to ensure links between all new segments are correct."""
    print("\nPost-processing: Updating links between new segments...")
    all_new_clipitems_map: Dict[str, ET.Element] = {
        item.attrib["id"]: item
        for track in all_tracks
        for item in track.findall("clipitem")
        if "id" in item.attrib
    }

    processed_ids = set(processed_clips_data.keys())

    for original_id in processed_ids:
        segments_data = processed_clips_data.get(original_id)
        if not segments_data:
            continue

        if original_id not in clipitem_elements:
            continue  # Should have been warned earlier
        original_clip_element = clipitem_elements[original_id]

        original_link_targets: Dict[int, Optional[str]] = {}
        for idx, link in enumerate(original_clip_element.findall(".//link")):
            linkclipref = link.find("linkclipref")
            original_link_targets[idx] = (
                linkclipref.text if linkclipref is not None else None
            )

        original_partner_ids = linked_clips_map.get(original_id, set())

        for i, current_segment_data in enumerate(segments_data):
            current_segment_id = cast(str, current_segment_data["new_id"])
            current_segment_element = all_new_clipitems_map.get(current_segment_id)

            if current_segment_element is None:
                continue

            new_links = current_segment_element.findall(".//link")
            if len(new_links) != len(original_link_targets):
                print(
                    f"  Warning: Link count mismatch for segment {current_segment_id}.",
                    file=sys.stderr,
                )

            for link_idx, link_element in enumerate(new_links):
                linkclipref = link_element.find("linkclipref")
                if linkclipref is None:
                    continue

                original_target = original_link_targets.get(
                    link_idx
                )  # Target of the original link at this index

                if original_target == original_id:  # Was a self-link
                    if linkclipref.text != current_segment_id:
                        linkclipref.text = current_segment_id
                elif original_target in original_partner_ids:  # Was a partner link
                    partner_segments_data = processed_clips_data.get(original_target)
                    if partner_segments_data and i < len(partner_segments_data):
                        partner_segment_data = partner_segments_data[i]
                        if "new_id" in partner_segment_data:
                            partner_segment_id = cast(
                                str, partner_segment_data["new_id"]
                            )
                            if linkclipref.text != partner_segment_id:
                                linkclipref.text = partner_segment_id
                    else:  # Partner segment missing
                        if linkclipref.text == original_target:
                            print(
                                f"    Warning: Partner segment {i} for {original_target} missing. Link in {current_segment_id} not updated.",
                                file=sys.stderr,
                            )
                # else: Original link was something else or None, leave as is


# --- Main Execution Flow ---


def process_xml_main(
    input_path: Path, output_path: Path, silence_data: SilenceData
) -> bool:
    """Main processing function, orchestrates the refactored steps."""
    try:
        tree = ET.parse(input_path)
        root = tree.getroot()
    except Exception as e:  # Catch broad parse errors
        print(f"Error parsing XML file '{input_path}': {e}", file=sys.stderr)
        return False

    sequence = root.find("sequence")
    media = root.find("sequence/media")  # Be more specific
    if sequence is None or media is None:
        print(
            f"Error: Could not find <sequence>/<media> elements in '{input_path}'.",
            file=sys.stderr,
        )
        return False

    video_tracks: List[ET.Element] = media.findall("./video/track")
    audio_tracks: List[ET.Element] = media.findall("./audio/track")
    all_tracks: List[ET.Element] = video_tracks + audio_tracks

    # 1. Build initial data structures
    try:
        file_elements, clipitem_elements, linked_clips_map = build_project_data(
            root, all_tracks
        )
    except Exception as e:
        print(f"Error building project data: {e}", file=sys.stderr)
        return False

    # Shared dictionary to store results across track processing
    processed_clips_data: Dict[str, List[ClipSegmentData]] = {}
    max_timeline_duration: int = 0

    # 2. Process each track
    for track_idx, track in enumerate(all_tracks):
        is_video = track_idx < len(video_tracks)
        try:
            track_end_time = process_track(
                track,
                track_idx,
                is_video,
                file_elements,
                processed_clips_data,
                linked_clips_map,
                silence_data,
            )
            max_timeline_duration = max(max_timeline_duration, track_end_time)
        except Exception as e:
            print(f"Error processing track {track_idx+1}: {e}", file=sys.stderr)
            # Decide whether to continue or abort; let's continue for now
            # return False

    # 3. Post-process links
    try:
        update_all_segment_links(
            all_tracks, processed_clips_data, linked_clips_map, clipitem_elements
        )
    except Exception as e:
        print(f"Error updating segment links: {e}", file=sys.stderr)
        return False

    # 4. Update Sequence Duration
    duration_element = sequence.find("duration")
    if duration_element is not None:
        print(f"\nUpdating sequence duration to {max_timeline_duration}")
        duration_element.text = str(max_timeline_duration)
    else:
        print(f"Warning: Could not find sequence duration element.", file=sys.stderr)

    # 5. Write Output XML
    try:
        # ET.indent(tree) # Optional pretty print (Python 3.9+)
        tree.write(output_path, encoding="UTF-8", xml_declaration=True)
        print(f"\nSuccessfully created edited XML file: {output_path}")
        add_doctype(output_path)
        return True
    except IOError as e:
        print(f"Error writing output file '{output_path}': {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Unexpected error writing XML: {e}", file=sys.stderr)
        return False


# --- Argument Parsing and Main Execution (Keep unchanged) ---


def parse_arguments() -> argparse.Namespace:
    """Parses command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Remove silent sections from an FCP XML timeline based on ffmpeg silencedetect output.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "input_xml",
        type=Path,
        help="Path to the input FCP XML file (e.g., timeline.xml)",
    )
    parser.add_argument(
        "silence_json",
        type=Path,
        help="Path to the JSON file containing silence detection results. "
        "Format: {'/path/to/media1.mov': [{'start': s, 'end': s, 'duration': s}, ...], ...}",
    )
    parser.add_argument(
        "-o",
        "--output-xml",
        type=Path,
        default=None,
        help="Path for the output edited FCP XML file. "
        "Defaults to '[input_xml_name]_edited.xml' in the same directory.",
    )
    return parser.parse_args()


def load_silence_data(json_path: Path) -> Optional[SilenceData]:
    """Loads silence data from the specified JSON file."""
    try:
        with open(json_path, "r") as f:
            data: SilenceData = json.load(f)
            # Basic validation (can be expanded)
            if not isinstance(data, dict):
                print(
                    f"Error: Silence JSON content is not a dictionary ({json_path}).",
                    file=sys.stderr,
                )
                return None
            # Optional: Validate internal structure more thoroughly
            # for key, value in data.items():
            #    if not isinstance(value, list): ...
            #    for item in value:
            #        if not isinstance(item, dict) or not all(k in item for k in ['start', 'end']): ...

            # Normalize keys (file paths) just in case? Depends on how keys were generated.
            # normalized_data = {str(Path(k).resolve()): v for k, v in data.items()}
            # return normalized_data
            # For now, assume keys in JSON match XML <pathurl> strings directly after 'file://' removal
            return data
    except FileNotFoundError:
        print(f"Error: Silence JSON file not found: '{json_path}'", file=sys.stderr)
        return None
    except json.JSONDecodeError as e:
        print(f"Error decoding silence JSON file '{json_path}': {e}", file=sys.stderr)
        return None
    except Exception as e:  # Catch other potential errors
        print(
            f"An unexpected error occurred loading silence data from '{json_path}': {e}",
            file=sys.stderr,
        )
        return None


if __name__ == "__main__":
    args = parse_arguments()
    output_path: Path = args.output_xml
    if output_path is None:
        output_path = args.input_xml.with_name(
            f"{args.input_xml.stem}_edited{args.input_xml.suffix}"
        )

    print(f"Input XML:  {args.input_xml}")
    print(f"Silence JSON: {args.silence_json}")
    print(f"Output XML: {output_path}")

    silence_map = load_silence_data(args.silence_json)
    if silence_map is None:
        sys.exit(1)
    print(f"Loaded silence data for {len(silence_map)} files.")

    # Call the main orchestrator function
    success = process_xml_main(args.input_xml, output_path, silence_map)

    if success:
        print("Processing finished successfully.")
        sys.exit(0)
    else:
        print("Processing failed.")
        sys.exit(1)
