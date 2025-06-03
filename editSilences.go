package main

import (
	"fmt"
	"math"
	"sort"
)

const floatEpsilon = 1e-9

// MergeIntervals merges overlapping or adjacent intervals. Assumes 'End' is exclusive.
func MergeIntervals(intervals []SilenceInterval) []SilenceInterval {
	if len(intervals) == 0 {
		return []SilenceInterval{}
	}

	// Sort intervals by start time
	// A copy is made to avoid modifying the input slice if it's not desired,
	// though sort.Slice sorts in-place.
	sortedIntervals := make([]SilenceInterval, len(intervals))
	copy(sortedIntervals, intervals)
	sort.Slice(sortedIntervals, func(i, j int) bool {
		return sortedIntervals[i].Start < sortedIntervals[j].Start
	})

	merged := []SilenceInterval{}
	if len(sortedIntervals) == 0 {
		return merged
	}

	currentInterval := sortedIntervals[0]

	for i := 1; i < len(sortedIntervals); i++ {
		nextInterval := sortedIntervals[i]
		if nextInterval.Start <= currentInterval.End+floatEpsilon { // Tolerance for float comparison
			currentInterval.End = math.Max(currentInterval.End, nextInterval.End)
		} else {
			merged = append(merged, currentInterval)
			currentInterval = nextInterval
		}
	}
	merged = append(merged, currentInterval)
	return merged
}

// MapSourceToTimeline maps a source frame point/time (float) to its corresponding timeline point/time (float).
func MapSourceToTimeline(sourceFrameTime float64, clipData ClipData) float64 {
	timelineOffset := clipData.StartFrame - clipData.SourceStartFrame
	return sourceFrameTime + timelineOffset
}

// Helper function to create a default single, enabled edit instruction spanning the item
func defaultUncutEditInstruction(item *TimelineItem) []EditInstruction {
	return []EditInstruction{
		{
			SourceStartFrame: item.SourceStartFrame,
			SourceEndFrame:   item.SourceEndFrame,
			StartFrame:       item.StartFrame,
			EndFrame:         item.EndFrame,
			Enabled:          true,
		},
	}
}

func CreateEditsWithOptionalSilence(
	clipData ClipData,
	silences []SilenceInterval,
	keepSilenceSegments bool,
) []EditInstruction {
	editedClips := []EditInstruction{}
	originalSourceStart := clipData.SourceStartFrame
	originalSourceEndInclusive := clipData.SourceEndFrame
	originalTimelineStartFloat := clipData.StartFrame

	// --- Preprocessing Silences ---
	relevantSilences := []SilenceInterval{}
	for _, s := range silences {
		if s.Start <= originalSourceEndInclusive+floatEpsilon && s.End > originalSourceStart-floatEpsilon {
			relevantSilences = append(relevantSilences, s)
		}
	}

	clippedSilences := []SilenceInterval{}
	for _, s := range relevantSilences {
		cutStart := math.Max(originalSourceStart, s.Start)
		clipExclusiveEndBoundary := originalSourceEndInclusive + 1.0 // +1 Frame concept from Python
		cutEnd := math.Min(clipExclusiveEndBoundary, s.End)
		if cutEnd > cutStart+floatEpsilon {
			clipped := SilenceInterval{Start: cutStart, End: cutEnd}
			clippedSilences = append(clippedSilences, clipped)
		}
	}
	mergedSilences := MergeIntervals(clippedSilences)

	// --- Generate Edited Segments ---
	currentSourcePosInclusive := originalSourceStart
	currentOutputTimelineFloat := originalTimelineStartFloat
	lastTimelineEndInt := -1.0 // Sentinel value as float for direct comparison with frame values

	for _, silence := range mergedSilences {
		silenceStartInclusive := silence.Start
		silenceEndExclusive := silence.End

		// 1. ENABLED segment *before* this silence
		if silenceStartInclusive > currentSourcePosInclusive+floatEpsilon {
			segmentSourceStartInc := currentSourcePosInclusive
			segmentSourceEndExc := silenceStartInclusive
			// Make sure end_inc is truly inclusive of the frame just before silence
			segmentSourceEndInc := segmentSourceEndExc - floatEpsilon

			segmentDurationFloat := segmentSourceEndExc - segmentSourceStartInc

			var segmentTimelineStartFloat, segmentTimelineEndFloat float64

			if keepSilenceSegments {
				segmentTimelineStartFloat = MapSourceToTimeline(segmentSourceStartInc, clipData)
				segmentTimelineEndFloat = MapSourceToTimeline(segmentSourceEndExc, clipData)
			} else {
				segmentTimelineStartFloat = currentOutputTimelineFloat
				segmentTimelineEndFloat = currentOutputTimelineFloat + segmentDurationFloat
				currentOutputTimelineFloat = segmentTimelineEndFloat
			}

			segmentTimelineStartInt := math.Ceil(segmentTimelineStartFloat)
			// Floor the point just before the exclusive end to get inclusive end
			segmentTimelineEndInt := math.Floor(segmentTimelineEndFloat - floatEpsilon)

			if !keepSilenceSegments && lastTimelineEndInt != -1.0 {
				if segmentTimelineStartInt <= lastTimelineEndInt {
					segmentTimelineStartInt = lastTimelineEndInt + 1
				}
				// Python's optional gap filling logic:
				// else if segmentTimelineStartInt > lastTimelineEndInt + 1 {
				// segmentTimelineStartInt = lastTimelineEndInt + 1 // This might shorten segment
				// }
			}

			// Ensure end is not before start after potential adjustment
			if segmentTimelineEndInt >= segmentTimelineStartInt {
				firstEdit := EditInstruction{
					SourceStartFrame: segmentSourceStartInc,
					SourceEndFrame:   segmentSourceEndInc,
					StartFrame:       segmentTimelineStartInt,
					EndFrame:         segmentTimelineEndInt,
					Enabled:          true,
				}
				editedClips = append(editedClips, firstEdit)
				if !keepSilenceSegments {
					lastTimelineEndInt = segmentTimelineEndInt
				}
			} // else if !keepSilenceSegments { /* Segment skipped */ }
		}

		// 2. DISABLED segment *for* the silence itself (if requested)
		if keepSilenceSegments {
			segmentSourceStartInc := silenceStartInclusive
			segmentSourceEndExc := silenceEndExclusive
			segmentSourceEndInc := segmentSourceEndExc - floatEpsilon

			// Ensure segment has duration
			if segmentSourceEndExc > segmentSourceStartInc+floatEpsilon {
				segmentTimelineStartFloat := MapSourceToTimeline(segmentSourceStartInc, clipData)
				segmentTimelineEndFloat := MapSourceToTimeline(segmentSourceEndExc, clipData)

				segmentTimelineStartInt := math.Ceil(segmentTimelineStartFloat)
				segmentTimelineEndInt := math.Floor(segmentTimelineEndFloat - floatEpsilon)

				if segmentTimelineEndInt >= segmentTimelineStartInt {
					midEdit := EditInstruction{
						SourceStartFrame: segmentSourceStartInc,
						SourceEndFrame:   segmentSourceEndInc,
						StartFrame:       segmentTimelineStartInt,
						EndFrame:         segmentTimelineEndInt,
						Enabled:          false,
					}
					editedClips = append(editedClips, midEdit)
					// Don't update last_timeline_end_int for disabled segments
				}
			}
		}
		currentSourcePosInclusive = math.Max(currentSourcePosInclusive, silenceEndExclusive)
	}

	// --- Handle the final ENABLED segment *after* the last silence ---
	if currentSourcePosInclusive < originalSourceEndInclusive+floatEpsilon {
		segmentSourceStartInc := currentSourcePosInclusive
		segmentSourceEndInc := originalSourceEndInclusive
		// Approx exclusive end for calculations, consistent with Python
		segmentSourceEndExc := segmentSourceEndInc + floatEpsilon

		var segmentTimelineStartFloat, segmentTimelineEndFloat float64

		if keepSilenceSegments {
			segmentTimelineStartFloat = MapSourceToTimeline(segmentSourceStartInc, clipData)
			segmentTimelineEndFloat = MapSourceToTimeline(segmentSourceEndExc, clipData)
		} else {
			segmentTimelineStartFloat = currentOutputTimelineFloat
			segmentTimelineEndFloat = currentOutputTimelineFloat + (segmentSourceEndExc - segmentSourceStartInc)
			// No need to update current_output_timeline_float further
		}

		segmentTimelineStartInt := math.Ceil(segmentTimelineStartFloat)
		segmentTimelineEndInt := math.Floor(segmentTimelineEndFloat - floatEpsilon)

		if !keepSilenceSegments && lastTimelineEndInt != -1.0 {
			if segmentTimelineStartInt <= lastTimelineEndInt {
				segmentTimelineStartInt = lastTimelineEndInt + 1
			}
			// Optional: Adjust if gap detected? Usually not needed for final segment.
		}

		if segmentTimelineEndInt >= segmentTimelineStartInt {
			finalEdit := EditInstruction{
				SourceStartFrame: segmentSourceStartInc,
				SourceEndFrame:   segmentSourceEndInc, // This is originalSourceEndInclusive
				StartFrame:       segmentTimelineStartInt,
				EndFrame:         segmentTimelineEndInt,
				Enabled:          true,
			}
			editedClips = append(editedClips, finalEdit)
			// No need to update last_timeline_end_int after final segment
		}
	}

	// --- Optional Diagnostic Check ---
	if !keepSilenceSegments && len(editedClips) > 1 {
		for i := 0; i < len(editedClips)-1; i++ {
			clip1End := editedClips[i].EndFrame
			clip2Start := editedClips[i+1].StartFrame
			if math.Abs(clip2Start-(clip1End+1)) > floatEpsilon { // Compare with tolerance
				fmt.Printf("PROBLEM DETECTED between segment %d and %d:\n", i, i+1)
				fmt.Printf("  Seg %d ends: %f\n", i, clip1End)
				fmt.Printf("  Seg %d starts: %f\n", i+1, clip2Start) // Corrected index for printing
				if clip2Start <= clip1End {
					fmt.Printf("  ISSUE TYPE: Overlap or zero-duration gap (%.0f frame(s))\n", math.Ceil(clip1End-clip2Start+1))
				} else { // clip2Start > clip1End + 1
					fmt.Printf("  ISSUE TYPE: Gap (%.0f frame(s))\n", math.Floor(clip2Start-clip1End-1))
				}
			}
		}
	}

	return editedClips
}

func (a *App) CalculateAndStoreEditsForTimeline(projectData ProjectDataPayload, keepSilenceSegments bool) (ProjectDataPayload, error) {
	// We will modify the projectData directly. Since it's passed by value,
	// the caller receives a modified copy if we return it.

	for i := range projectData.Timeline.AudioTrackItems {
		item := &projectData.Timeline.AudioTrackItems[i] // Get a pointer to modify the item in the slice

		if item.SourceFilePath == "" {
			fmt.Printf("Info: Audio item %s (ID: %s) has no source file path, skipping edit calculation.\n", item.Name, item.ID)
			// Optionally ensure it has a default single edit instruction
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		fileData, ok := projectData.Files[item.SourceFilePath]
		if !ok {
			fmt.Printf("Warning: No FileData found for source path %s (audio item %s). Skipping edit calculation.\n", item.SourceFilePath, item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		// Get FPS for the current source file to convert silence times
		sourceFileFPS := fileData.Properties.FPS
		if sourceFileFPS <= 0 {
			fmt.Printf("Warning: Invalid FPS (%f) for source file %s (audio item %s). Cannot convert silences to frames. Skipping edit calculation.\n", sourceFileFPS, item.SourceFilePath, item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		// Convert []*SilenceInterval (assumed to be in SECONDS) to []SilenceInterval (in FRAMES)
		var frameBasedSilences []SilenceInterval
		if fileData.SilenceDetections != nil {
			for _, silenceInSecondsPtr := range fileData.SilenceDetections {
				if silenceInSecondsPtr != nil {
					// Convert Start and End from seconds to frames
					startFrame := silenceInSecondsPtr.Start * sourceFileFPS
					endFrame := silenceInSecondsPtr.End * sourceFileFPS
					frameBasedSilences = append(frameBasedSilences, SilenceInterval{
						Start: startFrame,
						End:   endFrame,
					})
				}
			}
		}
		// For debugging the conversion:
		// fmt.Printf("DEBUG: Item: %s, Original Silences (seconds, from FileData): %+v\n", item.Name, fileData.SilenceDetections)
		// fmt.Printf("DEBUG: Item: %s, Converted Silences (frames, FPS: %f): %+v\n", item.Name, sourceFileFPS, frameBasedSilences)

		clipDataItem := ClipData{
			SourceStartFrame: item.SourceStartFrame,
			SourceEndFrame:   item.SourceEndFrame, // Inclusive
			StartFrame:       item.StartFrame,
			EndFrame:         item.EndFrame, // Inclusive
		}
		// fmt.Printf("DEBUG: Item: %s, ClipData for CreateEdits: %+v\n", item.Name, clipDataItem)

		editInstructions := CreateEditsWithOptionalSilence(clipDataItem, frameBasedSilences, keepSilenceSegments)
		item.EditInstructions = editInstructions
		// fmt.Printf("DEBUG: Item: %s, Generated EditInstructions: %+v\n", item.Name, editInstructions)
	}

	// The Python snippet `timeline_items.append(item)` where
	// `timeline_items = project_data["files"][clip_file_path]["timelineItems"]`
	// is not directly replicated here. That line seems to modify a different part of the
	// data structure (`project_data["files"]...["timelineItems"]`).
	// The current Go function focuses on populating `EditInstructions` for items
	// directly in `projectData.Timeline.AudioTrackItems` and `projectData.Timeline.VideoTrackItems`,
	// which matches the `item["edit_instructions"] = edit_instructions` part of the Python logic.
	// If that append operation is also essential, the Go function would need further modification
	// to also update `projectData.Files[...].TimelineItems`. However, this could lead to
	// data duplication or unintended side effects if not handled carefully.
	// For now, this Go code strictly adheres to placing edits on the primary timeline items.

	return projectData, nil
}
