package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
)

// OTIORationalTime represents OpenTimelineIO RationalTime.
type OTIORationalTime struct {
	Rate  float64 `json:"rate"`
	Value float64 `json:"value"`
}

// OTIOTimeRange represents OpenTimelineIO TimeRange.
type OTIOTimeRange struct {
	Duration  OTIORationalTime `json:"duration"`
	StartTime OTIORationalTime `json:"start_time"`
}

// OTIOResolveMetadata holds Resolve-specific OTIO metadata.
type OTIOResolveMetadata struct {
	LinkGroupID *int `json:"Link Group ID"`
}

// OTIOMetadata wraps Resolve_OTIO metadata.
type OTIOMetadata struct {
	ResolveOTIO *OTIOResolveMetadata `json:"Resolve_OTIO"`
}

// OTIOChildItem represents an OTIO track child: Gap, Clip, or Stack.
type OTIOChildItem struct {
	OTIOSchema  string         `json:"OTIO_SCHEMA"`
	Name        string         `json:"name"`
	SourceRange *OTIOTimeRange `json:"source_range"`
	Metadata    *OTIOMetadata  `json:"metadata"`
}

// OTIOTrack represents an OTIO track with kind (Video, Audio, Subtitle) and its children.
type OTIOTrack struct {
	OTIOSchema string          `json:"OTIO_SCHEMA"`
	Kind       string          `json:"kind"`
	Name       string          `json:"name"`
	Children   []OTIOChildItem `json:"children"`
}

// OTIOTracksStack represents the tracks stack in the OTIO timeline.
type OTIOTracksStack struct {
	OTIOSchema string      `json:"OTIO_SCHEMA"`
	Children   []OTIOTrack `json:"children"`
}

// OTIOTimeline represents the root OTIO Timeline document exported by DaVinci Resolve.
type OTIOTimeline struct {
	OTIOSchema      string           `json:"OTIO_SCHEMA"`
	Name            string           `json:"name"`
	GlobalStartTime OTIORationalTime `json:"global_start_time"`
	Tracks          OTIOTracksStack  `json:"tracks"`
}

// ParseOTIOLinkGroups reads an OTIO file from disk and populates LinkGroupID on matching
// TimelineItems in ProjectDataPayload.
func ParseOTIOLinkGroups(otioPath string, pd *ProjectDataPayload) error {
	if pd == nil {
		return fmt.Errorf("project data is nil")
	}

	data, err := os.ReadFile(otioPath)
	if err != nil {
		return fmt.Errorf("failed to read OTIO file %s: %w", otioPath, err)
	}

	var otioTimeline OTIOTimeline
	if err := json.Unmarshal(data, &otioTimeline); err != nil {
		return fmt.Errorf("failed to unmarshal OTIO JSON: %w", err)
	}

	return ApplyOTIOLinkGroupsToProjectData(&otioTimeline, pd)
}

// ApplyOTIOLinkGroupsToProjectData applies link group IDs from an unmarshaled OTIOTimeline
// onto the matching video and audio TimelineItems in ProjectDataPayload.
func ApplyOTIOLinkGroupsToProjectData(otioTimeline *OTIOTimeline, pd *ProjectDataPayload) error {
	if otioTimeline == nil || pd == nil {
		return fmt.Errorf("invalid nil arguments")
	}

	const frameTolerance = 0.5
	const searchRange = 5.0

	globalStartFrame := otioTimeline.GlobalStartTime.Value
	trackTypeCounters := make(map[string]int)

	for _, track := range otioTimeline.Tracks.Children {
		kind := strings.ToLower(track.Kind)
		if kind != "video" && kind != "audio" {
			continue
		}

		trackTypeCounters[kind]++
		trackIndex := trackTypeCounters[kind]

		var targetItems []TimelineItem
		if kind == "video" {
			targetItems = pd.Timeline.VideoTrackItems
		} else {
			targetItems = pd.Timeline.AudioTrackItems
		}

		playheadFrames := 0.0

		for _, child := range track.Children {
			durationVal := 0.0
			if child.SourceRange != nil {
				durationVal = child.SourceRange.Duration.Value
			}

			schema := strings.ToLower(child.OTIOSchema)
			if strings.Contains(schema, "gap") {
				playheadFrames += durationVal
				continue
			}

			if strings.Contains(schema, "clip") || strings.Contains(schema, "stack") {
				recordFrame := playheadFrames + globalStartFrame

				// Find exact matches within frameTolerance
				var matchedIndices []int
				var bestFallbackIdx = -1
				var bestDistance = math.MaxFloat64

				for i, item := range targetItems {
					if item.TrackIndex != trackIndex {
						continue
					}

					frameDiff := math.Abs(item.StartFrame - recordFrame)
					durDiff := math.Abs(item.Duration - durationVal)

					if frameDiff < frameTolerance && durDiff < frameTolerance {
						matchedIndices = append(matchedIndices, i)
					} else if len(matchedIndices) == 0 && frameDiff <= searchRange && durDiff < frameTolerance {
						dist := frameDiff + durDiff
						if dist < bestDistance {
							bestDistance = dist
							bestFallbackIdx = i
						}
					}
				}

				if len(matchedIndices) == 0 && bestFallbackIdx >= 0 {
					matchedIndices = append(matchedIndices, bestFallbackIdx)
				}

				if len(matchedIndices) > 0 {
					var linkGroupID *int
					if child.Metadata != nil && child.Metadata.ResolveOTIO != nil && child.Metadata.ResolveOTIO.LinkGroupID != nil {
						val := *child.Metadata.ResolveOTIO.LinkGroupID
						linkGroupID = &val
					}

					for _, idx := range matchedIndices {
						if kind == "video" {
							pd.Timeline.VideoTrackItems[idx].LinkGroupID = linkGroupID
						} else {
							pd.Timeline.AudioTrackItems[idx].LinkGroupID = linkGroupID
						}
					}
				}

				playheadFrames += durationVal
			}
		}
	}

	return nil
}
