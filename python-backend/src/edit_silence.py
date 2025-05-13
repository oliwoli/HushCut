import math
from local_types import SilenceInterval, EditInstruction, ClipData


# --- Helper functions (merge_intervals, map_source_to_timeline) ---
def merge_intervals(
    intervals: list[SilenceInterval],
) -> list[SilenceInterval]:
    """Merges overlapping or adjacent intervals. Assumes 'end' is exclusive."""
    if not intervals:
        return []
    intervals.sort(key=lambda x: x["start"])
    merged: list[SilenceInterval] = []
    if not intervals:
        return []
    current_interval = intervals[0].copy()
    for i in range(1, len(intervals)):
        next_interval = intervals[i]
        if (
            next_interval["start"] <= current_interval["end"] + 1e-9
        ):  # Tolerance for float comparison
            current_interval["end"] = max(current_interval["end"], next_interval["end"])
        else:
            merged.append(current_interval)
            current_interval = next_interval.copy()
    merged.append(current_interval)
    return merged


def map_source_to_timeline(source_frame_time: float, clip_data: ClipData) -> float:
    """Maps a source frame point/time (float) to its corresponding timeline point/time (float)."""
    timeline_offset = float(clip_data["start_frame"]) - clip_data["source_start_frame"]
    return source_frame_time + timeline_offset


# --- Main Function (Ceil Start / Floor End for Robustness) ---
def create_edits_with_optional_silence(
    clip_data: ClipData,
    silences: list[SilenceInterval],
    keep_silence_segments: bool = False,
) -> list[EditInstruction]:
    """
    Creates edit instructions using float source times. Uses ceil(start) / floor(end)
    mapping for timeline frames to prioritize integer grid alignment.
    """
    edited_clips: list[EditInstruction] = []
    original_source_start = clip_data["source_start_frame"]
    original_source_end_inclusive = clip_data["source_end_frame"]
    original_timeline_start_int = clip_data["start_frame"]

    # --- Preprocessing Silences ---
    FLOAT_EPSILON = 1e-9
    relevant_silences = [
        s
        for s in silences
        if s["start"] <= original_source_end_inclusive + FLOAT_EPSILON
        and s["end"] > original_source_start - FLOAT_EPSILON
    ]
    clipped_silences = []
    for s in relevant_silences:
        cut_start = max(original_source_start, s["start"])
        clip_exclusive_end_boundary = (
            original_source_end_inclusive + 1.0
        )  # +1 Frame concept
        cut_end = min(clip_exclusive_end_boundary, s["end"])
        if cut_end > cut_start + FLOAT_EPSILON:
            clipped: SilenceInterval = {"start": cut_start, "end": cut_end}
            clipped_silences.append(clipped)
    merged_silences = merge_intervals(clipped_silences)

    # --- Generate Edited Segments ---
    current_source_pos_inclusive = original_source_start
    # Use float for tracking precise timeline position when removing silences
    current_output_timeline_float = float(original_timeline_start_int)
    # Keep track of last integer end frame for contiguity check/fix if needed
    last_timeline_end_int = -1  # Sentinel value

    for silence in merged_silences:
        silence_start_inclusive = silence["start"]
        silence_end_exclusive = silence["end"]

        # 1. ENABLED segment *before* this silence
        if silence_start_inclusive > current_source_pos_inclusive + FLOAT_EPSILON:
            segment_source_start_inc = current_source_pos_inclusive
            segment_source_end_exc = silence_start_inclusive
            segment_source_end_inc = segment_source_end_exc - FLOAT_EPSILON

            segment_duration_float = segment_source_end_exc - segment_source_start_inc

            if keep_silence_segments:
                # Map source times to float timeline times
                segment_timeline_start_float = map_source_to_timeline(
                    segment_source_start_inc, clip_data
                )
                segment_timeline_end_float = map_source_to_timeline(
                    segment_source_end_exc, clip_data
                )
            else:
                # Calculate float start/end based on running float timeline position
                segment_timeline_start_float = current_output_timeline_float
                segment_timeline_end_float = (
                    current_output_timeline_float + segment_duration_float
                )
                # Update the running position *precisely* for the next segment
                current_output_timeline_float = segment_timeline_end_float

            # --- Integer Frame Conversion (Ceil Start / Floor End) ---
            # Nudge start slightly *before* ceiling if it's extremely close to integer below? No, ceil should handle 100.0 correctly.
            segment_timeline_start_int = math.ceil(segment_timeline_start_float)
            # Floor the point just before the exclusive end to get inclusive end
            segment_timeline_end_int = math.floor(
                segment_timeline_end_float - FLOAT_EPSILON
            )

            # --- Contiguity Adjustment (Post-Calculation) for keep_silence_segments=False ---
            # If this isn't the first segment AND we are removing silences,
            # check for overlap/gap with the *previous calculated* segment.
            if not keep_silence_segments and last_timeline_end_int != -1:
                # If current calculated start is <= previous end, force it to follow
                if segment_timeline_start_int <= last_timeline_end_int:
                    segment_timeline_start_int = last_timeline_end_int + 1
                # If current calculated start > previous end + 1, there's a gap (less likely with ceil/floor, but check)
                # In this case, we usually just accept the calculated start to avoid stretching.
                # Or should we force start = last_end + 1? Let's force it for now for max contiguity.
                # elif segment_timeline_start_int > last_timeline_end_int + 1:
                #     segment_timeline_start_int = last_timeline_end_int + 1 # This might shorten segment

            # Ensure end is not before start after potential adjustment
            if segment_timeline_end_int >= segment_timeline_start_int:
                first_edit: EditInstruction = {
                    "source_start_frame": segment_source_start_inc,
                    "source_end_frame": segment_source_end_inc,
                    "start_frame": segment_timeline_start_int,
                    "end_frame": segment_timeline_end_int,
                    "enabled": True,
                }
                edited_clips.append(first_edit)
                # Update last end frame only if segment was added and we're removing silence
                if not keep_silence_segments:
                    last_timeline_end_int = segment_timeline_end_int
            elif not keep_silence_segments:
                # If segment was skipped due to neg duration after adjustment,
                # keep the previous end frame marker.
                pass

        # 2. DISABLED segment *for* the silence itself (if requested)
        if keep_silence_segments:
            segment_source_start_inc = silence_start_inclusive
            segment_source_end_exc = silence_end_exclusive
            segment_source_end_inc = segment_source_end_exc - FLOAT_EPSILON

            if segment_source_end_exc > segment_source_start_inc + FLOAT_EPSILON:
                segment_timeline_start_float = map_source_to_timeline(
                    segment_source_start_inc, clip_data
                )
                segment_timeline_end_float = map_source_to_timeline(
                    segment_source_end_exc, clip_data
                )

                segment_timeline_start_int = math.ceil(segment_timeline_start_float)
                segment_timeline_end_int = math.floor(
                    segment_timeline_end_float - FLOAT_EPSILON
                )

                if segment_timeline_end_int >= segment_timeline_start_int:
                    mid_edit: EditInstruction = {
                        "source_start_frame": segment_source_start_inc,
                        "source_end_frame": segment_source_end_inc,
                        "start_frame": segment_timeline_start_int,
                        "end_frame": segment_timeline_end_int,
                        "enabled": False,
                    }
                    edited_clips.append(mid_edit)
                    # Don't update last_timeline_end_int for disabled segments

        # Update the source position for the next iteration
        current_source_pos_inclusive = max(
            current_source_pos_inclusive, silence_end_exclusive
        )

    # --- Handle the final ENABLED segment *after* the last silence ---
    if current_source_pos_inclusive < original_source_end_inclusive + FLOAT_EPSILON:
        segment_source_start_inc = current_source_pos_inclusive
        segment_source_end_inc = original_source_end_inclusive
        segment_source_end_exc = (
            segment_source_end_inc + FLOAT_EPSILON
        )  # Approx exclusive end

        if keep_silence_segments:
            segment_timeline_start_float = map_source_to_timeline(
                segment_source_start_inc, clip_data
            )
            segment_timeline_end_float = map_source_to_timeline(
                segment_source_end_exc, clip_data
            )
        else:
            segment_timeline_start_float = current_output_timeline_float
            segment_timeline_end_float = current_output_timeline_float + (
                segment_source_end_exc - segment_source_start_inc
            )
            # No need to update current_output_timeline_float further

        segment_timeline_start_int = math.ceil(segment_timeline_start_float)
        segment_timeline_end_int = math.floor(
            segment_timeline_end_float - FLOAT_EPSILON
        )

        # --- Contiguity Adjustment for Final Segment ---
        if not keep_silence_segments and last_timeline_end_int != -1:
            if segment_timeline_start_int <= last_timeline_end_int:
                segment_timeline_start_int = last_timeline_end_int + 1
            # Optional: Adjust if gap detected? Usually not needed for final segment.

        if segment_timeline_end_int >= segment_timeline_start_int:
            final_edit: EditInstruction = {
                "source_start_frame": segment_source_start_inc,
                "source_end_frame": segment_source_end_inc,
                "start_frame": segment_timeline_start_int,
                "end_frame": segment_timeline_end_int,
                "enabled": True,
            }
            edited_clips.append(final_edit)
            # No need to update last_timeline_end_int after final segment

    # --- Optional Diagnostic Check ---
    if not keep_silence_segments and len(edited_clips) > 1:
        has_issue = False
        for i in range(len(edited_clips) - 1):
            # Check only enabled segments if keep_silence_segments is True? No, check all for this diagnostic.
            clip1_end = edited_clips[i]["end_frame"]
            clip2_start = edited_clips[i + 1]["start_frame"]
            if clip2_start != clip1_end + 1:
                has_issue = True
                print(f"PROBLEM DETECTED between segment {i} and {i+1}:")
                print(f"  Seg {i} ends: {clip1_end}")
                print(f"  Seg {i+1} starts: {clip2_start}")
                if clip2_start <= clip1_end:
                    print(
                        f"  ISSUE TYPE: Overlap ({clip1_end - clip2_start + 1} frame(s))"
                    )
                else:  # clip2_start > clip1_end + 1
                    print(f"  ISSUE TYPE: Gap ({clip2_start - clip1_end - 1} frame(s))")

    return edited_clips


if __name__ == "__main__":
    # --- Example Usage ---

    clip_example: ClipData = {
        "source_start_frame": 100,  # Source 100 -> Timeline 50
        "source_end_frame": 399,  # Source 399 -> Timeline 349 (300 frames duration)
        "start_frame": 50,
        "end_frame": 349,
    }
    # Silences: Source 150-179 (Dur 30), Source 250-299 (Dur 50)
    silences_example: list[SilenceInterval] = [
        {"start": 150, "end": 180},
        {"start": 250, "end": 300},
    ]

    # --- Case 1: keep_silence_segments = False (Remove silences, shift timeline) ---
    print("--- Example: keep_silence_segments = False ---")
    edits_remove = create_edits_with_optional_silence(
        clip_example, silences_example, keep_silence_segments=False
    )
    print(f"Original Clip: {clip_example}")
    print(f"Silences (Source Relative): {silences_example}")
    print("Edited Clips (Removing Silence):")
    for segment in edits_remove:
        print(f"  {segment}")

    # Expected Output (Removing Silence):
    # Segment 1 (Source): 100-149 (Dur 50). Original Timeline: 50-99. New Timeline: 50-99.
    # Segment 2 (Source): 180-249 (Dur 70). Original Timeline: 130-199. New Timeline: 100-169.
    # Segment 3 (Source): 300-399 (Dur 100). Original Timeline: 250-349. New Timeline: 170-269.
    # Total Duration Removed = 30 + 50 = 80 frames. Original Dur = 300. New Dur = 220.
    # Clip 1: src=100-149, start=50, end=99, enabled=True
    # Clip 2: src=180-249, start=100, end=169, enabled=True
    # Clip 3: src=300-399, start=170, end=269, enabled=True

    # --- Case 2: keep_silence_segments = True (Mark silences as disabled) ---
    print("\n--- Example: keep_silence_segments = True ---")
    edits_keep = create_edits_with_optional_silence(
        clip_example, silences_example, keep_silence_segments=True
    )
    print(f"Original Clip: {clip_example}")
    print(f"Silences (Source Relative): {silences_example}")
    print("Edited Clips (Keeping Silence Disabled):")
    for edit in edits_keep:
        print(f"  {edit}")

    # Expected Output (Keeping Silence):
    # Segment 1 (Source): 100-149 (Dur 50). Timeline: 50-99. Enabled: True.
    # Segment 2 (Source): 150-179 (Dur 30). Timeline: 100-129. Enabled: False.
    # Segment 3 (Source): 180-249 (Dur 70). Timeline: 130-199. Enabled: True.
    # Segment 4 (Source): 250-299 (Dur 50). Timeline: 200-249. Enabled: False.
    # Segment 5 (Source): 300-399 (Dur 100). Timeline: 250-349. Enabled: True.
    # Clip 1: src=100-149, start=50, end=99, enabled=True
    # Clip 2: src=150-179, start=100, end=129, enabled=False
    # Clip 3: src=180-249, start=130, end=199, enabled=True
    # Clip 4: src=250-299, start=200, end=249, enabled=False
    # Clip 5: src=300-399, start=250, end=349, enabled=True

    print("\n--- Example: Silence covers entire clip (keep=True) ---")
    clip_all_silent: ClipData = {
        "source_start_frame": 100,
        "source_end_frame": 199,
        "start_frame": 1000,
        "end_frame": 1099,
    }

    silence_all: list[SilenceInterval] = [{"start": 50, "end": 250}]
    edits_all_silent_keep = create_edits_with_optional_silence(
        clip_all_silent, silence_all, keep_silence_segments=True
    )
    print(f"Original Clip: {clip_all_silent}")
    print(f"Silences (Source Relative): {silence_all}")
    print("Edited Clips (Keeping Silence Disabled):")
    for edit in edits_all_silent_keep:
        print(f"  {edit}")
    # Expected: One segment, covering the whole clip, enabled=False
    # Clip 1: src=100-199, start=1000, end=1099, enabled=False

    print("\n--- Example: Silence covers entire clip (keep=False) ---")
    edits_all_silent_remove = create_edits_with_optional_silence(
        clip_all_silent, silence_all, keep_silence_segments=False
    )
    print(f"Original Clip: {clip_all_silent}")
    print(f"Silences (Source Relative): {silence_all}")
    print("Edited Clips (Removing Silence):")
    print(f"  {edits_all_silent_remove}")
    # Expected: Empty list []
