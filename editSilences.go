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
	projectData ProjectDataPayload,
	keepSilenceSegments bool,
	allClipSilencesMap map[string][]SilencePeriod,
) (ProjectDataPayload, error) {

	if len(projectData.Timeline.AudioTrackItems) == 0 {
		log.Println("CalculateAndStoreEditsForTimeline: No audio track items to process.")
		return projectData, nil
	}

	timelineFPS := projectData.Timeline.FPS
	if timelineFPS <= floatEpsilon {
		return projectData, fmt.Errorf("invalid timeline FPS: %.2f", timelineFPS)
	}

	for i := range projectData.Timeline.AudioTrackItems {
		item := &projectData.Timeline.AudioTrackItems[i]

		itemSpecificSilencesInSeconds, silencesFound := allClipSilencesMap[item.ID]
		if !silencesFound {
			log.Printf("Info: No silence data provided for item '%s'. Applying default uncut edit.", item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		// --- CORE FIX: Use Timeline FPS for all conversions ---
		// We no longer need to look up the file's individual FPS. This makes the
		// logic consistent for both regular clips and compound clips.
		var frameBasedSilences []SilenceInterval
		if len(itemSpecificSilencesInSeconds) > 0 {
			for _, silenceInSec := range itemSpecificSilencesInSeconds {
				startFrame := silenceInSec.Start * timelineFPS
				endFrame := silenceInSec.End * timelineFPS
				if endFrame > startFrame+floatEpsilon {
					frameBasedSilences = append(frameBasedSilences, SilenceInterval{
						Start: startFrame,
						End:   endFrame,
					})
				}
			}
		}

		// The ClipData now correctly uses the item's own source frames.
		// For compound clips, Python has already adjusted these to be 0-based relative
		// to the start of the mixdown file.
		clipDataItem := ClipData{
			SourceStartFrame: item.SourceStartFrame,
			SourceEndFrame:   item.SourceEndFrame,
			StartFrame:       item.StartFrame,
			EndFrame:         item.EndFrame,
		}

		editInstructions := CreateEditsWithOptionalSilence(clipDataItem, frameBasedSilences, keepSilenceSegments)
		item.EditInstructions = editInstructions
	}

	return projectData, nil
}
