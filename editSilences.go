package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
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

func round(f float64) int64 {
	return int64(math.Round(f))
}

func CreateEditsWithOptionalSilence(
	clipData ClipData,
	silences []SilenceInterval,
	sourceFPS float64,
	timelineFPS float64,
	keepSilenceSegments bool,
) []EditInstruction {
	const eps = floatEpsilon
	frameRateRatio := timelineFPS / sourceFPS

	// Cull & clip silences
	var relevant []SilenceInterval
	for _, s := range silences {
		if s.Start < clipData.SourceEndFrame+eps && s.End > clipData.SourceStartFrame-eps {
			start := math.Max(clipData.SourceStartFrame, s.Start)
			end := math.Min(clipData.SourceEndFrame, s.End)
			if end > start+eps {
				relevant = append(relevant, SilenceInterval{Start: start, End: end})
			}
		}
	}
	merged := MergeIntervals(relevant)

	if len(merged) == 0 {
		return []EditInstruction{{
			SourceStartFrame: clipData.SourceStartFrame, SourceEndFrame: clipData.SourceEndFrame,
			StartFrame: clipData.StartFrame, EndFrame: clipData.EndFrame, Enabled: true,
		}}
	}

	var edits []EditInstruction

	sourceCursorF := clipData.SourceStartFrame
	timelineCursorF := clipData.StartFrame

	// This helper function contains the core logic for creating and validating an edit.
	emitEdit := func(srcStart, srcEnd float64, tlStart, tlEnd int64, enabled bool) {
		timelineDurationFrames := tlEnd - tlStart
		if timelineDurationFrames <= 0 {
			return
		}

		sourceDuration := srcEnd - srcStart
		if round(sourceDuration) < timelineDurationFrames {
			srcEnd = srcStart + float64(timelineDurationFrames)
		}
		if srcEnd > clipData.SourceEndFrame {
			srcEnd = clipData.SourceEndFrame
		}

		edits = append(edits, EditInstruction{
			SourceStartFrame: srcStart,
			SourceEndFrame:   srcEnd,
			StartFrame:       float64(tlStart),
			EndFrame:         float64(tlEnd),
			Enabled:          enabled,
		})

	}

	for _, sil := range merged {
		// --- Process Sound Segment ---
		soundSourceDuration := sil.Start - sourceCursorF
		if soundSourceDuration > eps {
			soundTimelineDuration := soundSourceDuration * frameRateRatio
			startFrame := round(timelineCursorF)
			nextClipStartFrame := round(timelineCursorF + soundTimelineDuration)
			durationInFrames := nextClipStartFrame - startFrame
			endFrame := startFrame + durationInFrames

			if durationInFrames > 0 {
				timelineRoundingOffset := float64(startFrame) - timelineCursorF
				sourceRoundingOffset := timelineRoundingOffset / frameRateRatio

				//maybeOffset := (soundTimelineDuration - float64(durationInFrames)) / frameRateRatio

				sourceStart := sourceCursorF + sourceRoundingOffset
				sourceEnd := sil.Start - eps
				if sourceEnd > clipData.SourceEndFrame {
					sourceEnd = clipData.SourceEndFrame
				}
				// if !keepSilenceSegments && len(edits) > 0 {
				// 	sourceStart += math.Abs(maybeOffset)
				// 	secondOffset := float64(round(sourceEnd-sourceStart)) - (sourceEnd - sourceStart)
				// 	sourceStart += math.Abs(secondOffset / 2)
				// }

				emitEdit(sourceStart, sourceEnd, startFrame, endFrame, true)
			}
			timelineCursorF += soundTimelineDuration
		}

		// --- Process Silence Segment ---
		// This block is only entered if keepSilenceSegments is true.
		// If false, the timeline cursor does NOT advance, creating the cut.
		silenceSourceDuration := sil.End - sil.Start
		if silenceSourceDuration > eps && keepSilenceSegments {
			silenceTimelineDuration := silenceSourceDuration * frameRateRatio

			startFrame := round(timelineCursorF)
			nextClipStartFrame := round(timelineCursorF + silenceTimelineDuration)
			durationInFrames := nextClipStartFrame - startFrame
			endFrame := startFrame + durationInFrames

			if durationInFrames > 0 {
				timelineRoundingOffset := float64(startFrame) - timelineCursorF
				sourceRoundingOffset := timelineRoundingOffset / frameRateRatio
				sourceStart := sil.Start + sourceRoundingOffset
				sourceEnd := sil.End - eps
				emitEdit(sourceStart, sourceEnd, startFrame, endFrame, false)
			}
			timelineCursorF += silenceTimelineDuration
		}
		sourceCursorF = sil.End
	}

	// --- Process Final Segment ---
	finalSoundSourceDuration := clipData.SourceEndFrame - sourceCursorF
	if finalSoundSourceDuration > eps {
		startFrame := round(timelineCursorF)
		endFrame := round(clipData.EndFrame)

		if endFrame >= startFrame && keepSilenceSegments {
			timelineRoundingOffset := float64(startFrame) - timelineCursorF
			sourceRoundingOffset := timelineRoundingOffset / frameRateRatio
			sourceStart := sourceCursorF + sourceRoundingOffset
			sourceEnd := clipData.SourceEndFrame
			// Use emitEdit for the final segment as well to ensure it gets padded if necessary
			// when keeping silences.
			emitEdit(sourceStart, sourceEnd, startFrame, endFrame, true)
		}
	}

	// The Final Continuity Pass is also correctly conditional.
	if keepSilenceSegments {
		for i := 0; i < len(edits)-1; i++ {
			edits[i].SourceEndFrame = edits[i+1].SourceStartFrame - eps
		}
	} else {
		for i := 0; i < len(edits)-1; i++ {
			//edits[i].EndFrame = edits[i+1].StartFrame
			edits[i].SourceEndFrame = edits[i].SourceStartFrame + (edits[i].EndFrame-edits[i].StartFrame)/frameRateRatio
		}
	}

	return edits
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
	projectFPS := projectData.Timeline.ProjectFPS // Use ProjectFPS as the source rate
	if timelineFPS <= floatEpsilon || projectFPS <= floatEpsilon {
		return projectData, fmt.Errorf("invalid FPS values: timeline=%.2f, project=%.2f", timelineFPS, projectFPS)
	}

	log.Printf("timelineFPS is %f - projectFPS is %f\n", timelineFPS, projectFPS)

	for i := range projectData.Timeline.AudioTrackItems {
		item := &projectData.Timeline.AudioTrackItems[i]
		//log.Printf("sourceFPS is %f", item.SourceFPS)
		// Ratio to convert source frames FROM timeline domain TO project domain for processing.
		sourceToTimelineFpsRatio := item.SourceFPS / timelineFPS
		itemSpecificSilencesInSeconds, silencesFound := allClipSilencesMap[item.ID]
		if !silencesFound {
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

		var frameBasedSilences []SilenceInterval
		if len(itemSpecificSilencesInSeconds) > 0 {
			for _, silenceInSec := range itemSpecificSilencesInSeconds {
				startFrame := silenceInSec.Start * item.SourceFPS
				endFrame := silenceInSec.End * item.SourceFPS
				if endFrame > startFrame+floatEpsilon {
					frameBasedSilences = append(frameBasedSilences, SilenceInterval{Start: startFrame, End: endFrame})
				}
			}
		}

		clipDataItem := ClipData{
			SourceStartFrame: item.SourceStartFrame * sourceToTimelineFpsRatio,
			SourceEndFrame:   item.SourceEndFrame * sourceToTimelineFpsRatio,
			// Timeline placement frames remain in the TIMELINE domain.
			StartFrame: item.StartFrame,
			EndFrame:   item.EndFrame,
		}

		editInstructions := CreateEditsWithOptionalSilence(clipDataItem, frameBasedSilences, item.SourceFPS, timelineFPS, keepSilenceSegments)
		// NO MORE CONVERSIONS. The returned source frames are already in the
		// correct project FPS domain, which is what the Python script expects.
		item.EditInstructions = editInstructions
	}

	debug_path := "debug_project_data_from_go.json"
	jsonString, err := json.MarshalIndent(projectData, "", " ")
	if err != nil {
		log.Println("Error marshaling project data to JSON:", err)
		return projectData, err
	}
	os.WriteFile(debug_path, jsonString, 0644)
	return projectData, nil
}
