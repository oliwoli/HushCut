package main

import (
	"fmt"
	"log"
	"math"
	"sort"
)

const floatEpsilon = 1e-9

func MergeIntervals(intervals []SilenceInterval) []SilenceInterval {
	if len(intervals) == 0 {
		return []SilenceInterval{}
	}
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
		if nextInterval.Start <= currentInterval.End+floatEpsilon {
			currentInterval.End = math.Max(currentInterval.End, nextInterval.End)
		} else {
			merged = append(merged, currentInterval)
			currentInterval = nextInterval
		}
	}
	merged = append(merged, currentInterval)
	return merged
}

func MapSourceToTimeline(sourceFrameTime float64, clipData ClipData) float64 {
	timelineOffset := clipData.StartFrame - clipData.SourceStartFrame
	return sourceFrameTime + timelineOffset
}

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

// Corrected CreateEditsWithOptionalSilence function
// This version preserves float64 precision for all frame numbers.
func CreateEditsWithOptionalSilence(
	clipData ClipData,
	silences []SilenceInterval, // Expects frame-based silences
	keepSilenceSegments bool,
) []EditInstruction {

	// --- Preprocessing Silences ---
	// (This section remains unchanged, as it correctly finds silences within the clip's source range)
	var relevantSilences []SilenceInterval
	for _, s := range silences {
		if s.Start <= clipData.SourceEndFrame+floatEpsilon && s.End > clipData.SourceStartFrame-floatEpsilon {
			relevantSilences = append(relevantSilences, s)
		}
	}
	var clippedSilences []SilenceInterval
	for _, s := range relevantSilences {
		cutStart := math.Max(clipData.SourceStartFrame, s.Start)
		clipExclusiveEndBoundary := clipData.SourceEndFrame + 1.0
		cutEnd := math.Min(clipExclusiveEndBoundary, s.End)
		if cutEnd > cutStart+floatEpsilon {
			clipped := SilenceInterval{Start: cutStart, End: cutEnd}
			clippedSilences = append(clippedSilences, clipped)
		}
	}
	mergedSilences := MergeIntervals(clippedSilences)

	if len(mergedSilences) == 0 {
		log.Printf("Debug: No effective silences found for clip. Creating a 1:1 pass-through edit instruction.")
		return []EditInstruction{
			{
				SourceStartFrame: clipData.SourceStartFrame,
				SourceEndFrame:   clipData.SourceEndFrame,
				StartFrame:       clipData.StartFrame,
				EndFrame:         clipData.EndFrame,
				Enabled:          true,
			},
		}
	}

	editedClips := []EditInstruction{}
	originalSourceStart := clipData.SourceStartFrame
	originalSourceEndInclusive := clipData.SourceEndFrame
	originalTimelineStartFloat := clipData.StartFrame

	currentSourcePosInclusive := originalSourceStart
	currentOutputTimelineFloat := originalTimelineStartFloat
	var lastTimelineEndFrame float64 = -1.0 // Use float64 for direct comparison

	for _, silence := range mergedSilences {
		silenceStartInclusive := silence.Start
		silenceEndExclusive := silence.End

		// 1. ENABLED segment *before* this silence
		if silenceStartInclusive > currentSourcePosInclusive+floatEpsilon {
			segmentSourceStartInc := currentSourcePosInclusive
			segmentSourceEndExc := silenceStartInclusive
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

			// Revert to integer snapping for timeline frames
			segmentTimelineStartFrame := math.Ceil(segmentTimelineStartFloat - floatEpsilon)
			segmentTimelineEndFrame := math.Floor(segmentTimelineEndFloat - floatEpsilon)

			// Prevent a 1-frame overlap when removing silences
			if !keepSilenceSegments && lastTimelineEndFrame != -1.0 {
				if segmentTimelineStartFrame <= lastTimelineEndFrame {
					segmentTimelineStartFrame = lastTimelineEndFrame + 1.0
				}
			}

			if segmentTimelineEndFrame >= segmentTimelineStartFrame {
				editedClips = append(editedClips, EditInstruction{
					SourceStartFrame: segmentSourceStartInc,
					SourceEndFrame:   segmentSourceEndInc,
					StartFrame:       segmentTimelineStartFrame,
					EndFrame:         segmentTimelineEndFrame,
					Enabled:          true,
				})
				if !keepSilenceSegments {
					lastTimelineEndFrame = segmentTimelineEndFrame
				}
			}
		}

		// 2. DISABLED segment *for* the silence itself (if requested)
		if keepSilenceSegments {
			segmentSourceStartInc := silenceStartInclusive
			segmentSourceEndExc := silenceEndExclusive
			segmentSourceEndInc := segmentSourceEndExc - floatEpsilon

			if segmentSourceEndExc > segmentSourceStartInc+floatEpsilon {
				// Snap timeline frames to integers
				segmentTimelineStartFrame := math.Ceil(MapSourceToTimeline(segmentSourceStartInc, clipData) - floatEpsilon)
				segmentTimelineEndFrame := math.Floor(MapSourceToTimeline(segmentSourceEndExc, clipData) - floatEpsilon)

				if segmentTimelineEndFrame >= segmentTimelineStartFrame {
					editedClips = append(editedClips, EditInstruction{
						SourceStartFrame: segmentSourceStartInc,
						SourceEndFrame:   segmentSourceEndInc,
						StartFrame:       segmentTimelineStartFrame,
						EndFrame:         segmentTimelineEndFrame,
						Enabled:          false,
					})
				}
			}
		}
		currentSourcePosInclusive = math.Max(currentSourcePosInclusive, silenceEndExclusive)
	}

	// --- Handle the final ENABLED segment *after* the last silence ---
	if currentSourcePosInclusive < originalSourceEndInclusive+floatEpsilon {
		segmentSourceStartInc := currentSourcePosInclusive
		segmentSourceEndInc := originalSourceEndInclusive
		segmentSourceEndExc := segmentSourceEndInc + 1.0
		segmentDurationFloat := segmentSourceEndExc - segmentSourceStartInc

		var segmentTimelineStartFloat, segmentTimelineEndFloat float64
		if keepSilenceSegments {
			segmentTimelineStartFloat = MapSourceToTimeline(segmentSourceStartInc, clipData)
			segmentTimelineEndFloat = MapSourceToTimeline(segmentSourceEndExc, clipData)
		} else {
			segmentTimelineStartFloat = currentOutputTimelineFloat
			segmentTimelineEndFloat = currentOutputTimelineFloat + segmentDurationFloat
		}

		// Revert to integer snapping for timeline frames
		segmentTimelineStartFrame := math.Ceil(segmentTimelineStartFloat - floatEpsilon)
		segmentTimelineEndFrame := math.Floor(segmentTimelineEndFloat - floatEpsilon)

		// Prevent a 1-frame overlap when removing silences
		if !keepSilenceSegments && lastTimelineEndFrame != -1.0 {
			if segmentTimelineStartFrame <= lastTimelineEndFrame {
				segmentTimelineStartFrame = lastTimelineEndFrame + 1.0
			}
		}

		if segmentTimelineEndFrame >= segmentTimelineStartFrame {
			editedClips = append(editedClips, EditInstruction{
				SourceStartFrame: segmentSourceStartInc,
				SourceEndFrame:   segmentSourceEndInc,
				StartFrame:       segmentTimelineStartFrame,
				EndFrame:         segmentTimelineEndFrame,
				Enabled:          true,
			})
		}
	}

	return editedClips
}

func (a *App) CalculateAndStoreEditsForTimeline(
	projectData ProjectDataPayload, // projectData itself is a struct, not a pointer.
	keepSilenceSegments bool,
	allClipSilencesMap map[string][]SilencePeriod, // map[clipId] -> []SilencePeriod (seconds-based, absolute to source)
) (ProjectDataPayload, error) {

	// Check if Timeline.AudioTrackItems slice is empty or if Timeline.FPS is invalid.
	// projectData.Timeline is a struct, so it won't be nil.
	if len(projectData.Timeline.AudioTrackItems) == 0 {
		log.Println("CalculateAndStoreEditsForTimeline: No audio track items to process.")
		return projectData, nil
	}
	if projectData.Timeline.FPS <= floatEpsilon {
		log.Printf("CalculateAndStoreEditsForTimeline: Invalid timeline FPS (%.2f). Cannot process.", projectData.Timeline.FPS)
		// Return projectData as is, but perhaps signal an error or handle more gracefully.
		// For now, just log and return. Depending on requirements, might be an error.
		return projectData, fmt.Errorf("invalid timeline FPS: %.2f", projectData.Timeline.FPS)
	}

	for i := range projectData.Timeline.AudioTrackItems {
		item := &projectData.Timeline.AudioTrackItems[i] // Get pointer to modify item in the slice

		itemSpecificSilencesInSeconds, silencesFound := allClipSilencesMap[item.ID]
		if !silencesFound {
			log.Printf("Info: No silence data provided in map for audio item '%s' (ID: %s). Applying default uncut edit instruction.\n", item.Name, item.ID)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		if item.SourceFilePath == "" {
			log.Printf("Info: Audio item '%s' (ID: %s) has no source file path. Cannot determine source FPS. Applying default uncut edit instruction.\n", item.Name, item.ID)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		fileData, fileDataFound := projectData.Files[item.SourceFilePath]
		if !fileDataFound { // No need to check if fileData is nil here
			log.Printf("Warning: No FileData found for source path '%s' (audio item '%s'). Cannot determine source FPS. Applying default uncut edit instruction.\n", item.SourceFilePath, item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		sourceFileFPS := fileData.Properties.FPS
		if sourceFileFPS <= floatEpsilon {
			log.Printf("Warning: Invalid source FPS (%.2f) for file '%s' (item '%s'). Cannot convert silences. Applying default uncut edit instruction.\n", sourceFileFPS, item.SourceFilePath, item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		var frameBasedSilences []SilenceInterval
		if len(itemSpecificSilencesInSeconds) > 0 {
			for _, silenceInSec := range itemSpecificSilencesInSeconds {
				startFrame := silenceInSec.Start * sourceFileFPS
				endFrame := silenceInSec.End * sourceFileFPS
				if endFrame > startFrame+floatEpsilon {
					frameBasedSilences = append(frameBasedSilences, SilenceInterval{
						Start: startFrame, // Inclusive frame
						End:   endFrame,   // Exclusive frame
					})
				}
			}
		}

		clipDataItem := ClipData{
			SourceStartFrame: item.SourceStartFrame,
			SourceEndFrame:   item.SourceEndFrame, // Inclusive
			StartFrame:       item.StartFrame,
			EndFrame:         item.EndFrame, // Inclusive
		}

		editInstructions := CreateEditsWithOptionalSilence(clipDataItem, frameBasedSilences, keepSilenceSegments)
		item.EditInstructions = editInstructions
	}

	return projectData, nil
}
