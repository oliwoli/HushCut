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

func round(f float64) int64 {
	return int64(math.Round(f))
}
func CreateEditsWithOptionalSilence(
	clipData ClipData,
	silences []SilenceInterval,
	keepSilenceSegments bool,
) []EditInstruction {
	const apiRoundingMargin = 0.4999
	const eps = floatEpsilon

	// 1) Cull & clip silences to [SourceStartFrame, SourceEndFrame+1)
	var relevant []SilenceInterval
	for _, s := range silences {
		if s.Start <= clipData.SourceEndFrame+eps &&
			s.End > clipData.SourceStartFrame-eps {
			start := math.Max(clipData.SourceStartFrame, s.Start)
			end := math.Min(clipData.SourceEndFrame+1.0, s.End)
			if end > start+eps {
				relevant = append(relevant, SilenceInterval{Start: start, End: end})
			}
		}
	}

	// 2) Merge overlaps
	merged := MergeIntervals(relevant)
	if len(merged) == 0 {
		// no silences → one straight pass
		return []EditInstruction{{
			SourceStartFrame: clipData.SourceStartFrame,
			SourceEndFrame:   clipData.SourceEndFrame,
			StartFrame:       clipData.StartFrame,
			EndFrame:         clipData.EndFrame,
			Enabled:          true,
		}}
	}

	// 3) Prepare dual cursors:
	//    - tlCursor: integer frame on the timeline
	//    - srcCursor: float source-frame position
	tlCursor := round(clipData.StartFrame)
	// mapTLToSrc & mapSrcToTL must be inverses
	offset := clipData.StartFrame - clipData.SourceStartFrame
	mapSrcToTL := func(src float64) float64 { return src + offset }
	mapTLToSrc := func(tl float64) float64 { return tl - offset }
	srcCursor := clipData.SourceStartFrame

	var edits []EditInstruction

	emit := func(frames int, enabled bool) {
		if frames <= 0 {
			return
		}
		srcStart := srcCursor
		srcEnd := srcCursor + float64(frames) - apiRoundingMargin

		edits = append(edits, EditInstruction{
			SourceStartFrame: srcStart,
			SourceEndFrame:   srcEnd,
			StartFrame:       float64(tlCursor),
			EndFrame:         float64(tlCursor + int64(frames) - 1),
			Enabled:          enabled,
		})

		tlCursor += int64(frames)
		// *** re-sync the float cursor exactly to where the timeline cursor maps back into source ***
		srcCursor = mapTLToSrc(float64(tlCursor))
	}

	// 4) Walk through each merged silence
	for _, sil := range merged {
		// — sound *before* the silence —
		untilSil := mapSrcToTL(sil.Start)
		framesPre := round(untilSil) - tlCursor
		emit(int(framesPre), true)

		// — optional silence chunk —
		untilSilEnd := mapSrcToTL(sil.End)
		framesSil := round(untilSilEnd) - tlCursor
		if keepSilenceSegments {
			emit(int(framesSil), false)
		} else {
			tlCursor += int64(framesSil)
			srcCursor = mapTLToSrc(float64(tlCursor))
		}
	}

	// 5) Final sound *after* last silence
	framesAfter := round(clipData.EndFrame) - tlCursor
	emit(int(framesAfter), true)

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
	if timelineFPS <= floatEpsilon {
		return projectData, fmt.Errorf("invalid timeline FPS: %.2f", timelineFPS)
	}

	for i := range projectData.Timeline.AudioTrackItems {
		item := &projectData.Timeline.AudioTrackItems[i]

		itemSpecificSilencesInSeconds, silencesFound := allClipSilencesMap[item.ID]
		if !silencesFound {
			//log.Printf("Info: No silence data provided for item '%s'. Applying default uncut edit.", item.Name)
			if len(item.EditInstructions) == 0 {
				item.EditInstructions = defaultUncutEditInstruction(item)
			}
			continue
		}

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
