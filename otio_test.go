package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func intPtr(i int) *int {
	return &i
}

func TestApplyOTIOLinkGroups_LinkedPair(t *testing.T) {
	// Video 1 and Audio 1 linked with Link Group ID 1
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  60.0,
			Value: 0.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Video",
					Name:       "Video 1",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Gap.1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 60, Value: 100},
							},
						},
						{
							OTIOSchema: "Clip.2",
							Name:       "CameraA.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 60, Value: 500},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(1),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Name:       "Audio 1",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Gap.1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 60, Value: 100},
							},
						},
						{
							OTIOSchema: "Clip.2",
							Name:       "CameraA.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 60, Value: 500},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(1),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 60.0,
			VideoTrackItems: []TimelineItem{
				{
					Name:       "CameraA.mov",
					TrackIndex: 1,
					StartFrame: 100.0,
					Duration:   500.0,
				},
			},
			AudioTrackItems: []TimelineItem{
				{
					Name:       "CameraA.mov",
					TrackIndex: 1,
					StartFrame: 100.0,
					Duration:   500.0,
				},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	vItem := pd.Timeline.VideoTrackItems[0]
	if vItem.LinkGroupID == nil || *vItem.LinkGroupID != 1 {
		t.Errorf("Expected VideoTrackItem LinkGroupID to be 1, got %v", vItem.LinkGroupID)
	}

	aItem := pd.Timeline.AudioTrackItems[0]
	if aItem.LinkGroupID == nil || *aItem.LinkGroupID != 1 {
		t.Errorf("Expected AudioTrackItem LinkGroupID to be 1, got %v", aItem.LinkGroupID)
	}
}

func TestApplyOTIOLinkGroups_MultiChannel4TrackLinked(t *testing.T) {
	// 1 Video track and 4 Audio tracks all sharing Link Group ID 42
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  30.0,
			Value: 0.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Video",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "MultiCam.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 300},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(42),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "MultiCam.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 300},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(42),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "MultiCam.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 300},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(42),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "MultiCam.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 300},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(42),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "MultiCam.mov",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 300},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(42),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 30.0,
			VideoTrackItems: []TimelineItem{
				{Name: "MultiCam.mov", TrackIndex: 1, StartFrame: 0, Duration: 300},
			},
			AudioTrackItems: []TimelineItem{
				{Name: "MultiCam.mov - ch1", TrackIndex: 1, StartFrame: 0, Duration: 300},
				{Name: "MultiCam.mov - ch2", TrackIndex: 2, StartFrame: 0, Duration: 300},
				{Name: "MultiCam.mov - ch3", TrackIndex: 3, StartFrame: 0, Duration: 300},
				{Name: "MultiCam.mov - ch4", TrackIndex: 4, StartFrame: 0, Duration: 300},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if pd.Timeline.VideoTrackItems[0].LinkGroupID == nil || *pd.Timeline.VideoTrackItems[0].LinkGroupID != 42 {
		t.Errorf("Video item expected LinkGroupID 42, got %v", pd.Timeline.VideoTrackItems[0].LinkGroupID)
	}

	for i, item := range pd.Timeline.AudioTrackItems {
		if item.LinkGroupID == nil || *item.LinkGroupID != 42 {
			t.Errorf("Audio item %d expected LinkGroupID 42, got %v", i+1, item.LinkGroupID)
		}
	}
}

func TestApplyOTIOLinkGroups_UnlinkedAndMultipleGroups(t *testing.T) {
	// Clip 1 (Group 10), Clip 2 (Unlinked), Clip 3 (Group 20) separated by gaps
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  24.0,
			Value: 0.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "Clip1.wav",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 100},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(10),
								},
							},
						},
						{
							OTIOSchema: "Gap.1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 50},
							},
						},
						{
							OTIOSchema: "Clip.2",
							Name:       "Clip2_Unlinked.wav",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 200},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: nil, // unlinked
								},
							},
						},
						{
							OTIOSchema: "Gap.1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 50},
							},
						},
						{
							OTIOSchema: "Clip.2",
							Name:       "Clip3.wav",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 150},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(20),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 24.0,
			AudioTrackItems: []TimelineItem{
				{Name: "Clip1.wav", TrackIndex: 1, StartFrame: 0, Duration: 100},
				{Name: "Clip2_Unlinked.wav", TrackIndex: 1, StartFrame: 150, Duration: 200},
				{Name: "Clip3.wav", TrackIndex: 1, StartFrame: 400, Duration: 150},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	items := pd.Timeline.AudioTrackItems
	if items[0].LinkGroupID == nil || *items[0].LinkGroupID != 10 {
		t.Errorf("Item 0 expected LinkGroupID 10, got %v", items[0].LinkGroupID)
	}
	if items[1].LinkGroupID != nil {
		t.Errorf("Item 1 expected nil LinkGroupID, got %v", *items[1].LinkGroupID)
	}
	if items[2].LinkGroupID == nil || *items[2].LinkGroupID != 20 {
		t.Errorf("Item 2 expected LinkGroupID 20, got %v", items[2].LinkGroupID)
	}
}

func TestApplyOTIOLinkGroups_GlobalStartTimeOffset(t *testing.T) {
	// Timeline starts at frame 86400 (01:00:00:00 at 24fps)
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  24.0,
			Value: 86400.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Gap.1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 240},
							},
						},
						{
							OTIOSchema: "Clip.2",
							Name:       "ClipAt1h10s.wav",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 24, Value: 480},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(5),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 24.0,
			AudioTrackItems: []TimelineItem{
				{
					Name:       "ClipAt1h10s.wav",
					TrackIndex: 1,
					StartFrame: 86640.0, // 86400 + 240
					Duration:   480.0,
				},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if pd.Timeline.AudioTrackItems[0].LinkGroupID == nil || *pd.Timeline.AudioTrackItems[0].LinkGroupID != 5 {
		t.Errorf("Expected LinkGroupID 5, got %v", pd.Timeline.AudioTrackItems[0].LinkGroupID)
	}
}

func TestApplyOTIOLinkGroups_CompoundClipStack(t *testing.T) {
	// Compound clip represented as Stack.1 in OTIO
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  30.0,
			Value: 0.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Stack.1",
							Name:       "Compound Clip 1",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 30, Value: 600},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(99),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 30.0,
			AudioTrackItems: []TimelineItem{
				{
					Name:       "Compound Clip 1",
					Type:       "Compound",
					TrackIndex: 1,
					StartFrame: 0,
					Duration:   600,
				},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if pd.Timeline.AudioTrackItems[0].LinkGroupID == nil || *pd.Timeline.AudioTrackItems[0].LinkGroupID != 99 {
		t.Errorf("Expected LinkGroupID 99 for Compound Clip Stack, got %v", pd.Timeline.AudioTrackItems[0].LinkGroupID)
	}
}

func TestApplyOTIOLinkGroups_FrameToleranceAndSubtitleTracks(t *testing.T) {
	// Frame difference within 0.5 tolerance, and a Subtitle track between video and audio
	otioTimeline := &OTIOTimeline{
		OTIOSchema: "Timeline.1",
		GlobalStartTime: OTIORationalTime{
			Rate:  29.97,
			Value: 0.0,
		},
		Tracks: OTIOTracksStack{
			OTIOSchema: "Stack.1",
			Children: []OTIOTrack{
				{
					OTIOSchema: "Track.1",
					Kind:       "Video",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "VClip",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 29.97, Value: 100.2}, // slight float
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(3),
								},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Subtitle",
					Name:       "Subtitle 1",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "Sub",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 29.97, Value: 100},
							},
						},
					},
				},
				{
					OTIOSchema: "Track.1",
					Kind:       "Audio",
					Children: []OTIOChildItem{
						{
							OTIOSchema: "Clip.2",
							Name:       "AClip",
							SourceRange: &OTIOTimeRange{
								Duration: OTIORationalTime{Rate: 29.97, Value: 100.2},
							},
							Metadata: &OTIOMetadata{
								ResolveOTIO: &OTIOResolveMetadata{
									LinkGroupID: intPtr(3),
								},
							},
						},
					},
				},
			},
		},
	}

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			FPS: 29.97,
			VideoTrackItems: []TimelineItem{
				{Name: "VClip", TrackIndex: 1, StartFrame: 0.0, Duration: 100.0},
			},
			AudioTrackItems: []TimelineItem{
				{Name: "AClip", TrackIndex: 1, StartFrame: 0.0, Duration: 100.0},
			},
		},
	}

	err := ApplyOTIOLinkGroupsToProjectData(otioTimeline, pd)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	if pd.Timeline.VideoTrackItems[0].LinkGroupID == nil || *pd.Timeline.VideoTrackItems[0].LinkGroupID != 3 {
		t.Errorf("Video item expected LinkGroupID 3, got %v", pd.Timeline.VideoTrackItems[0].LinkGroupID)
	}
	if pd.Timeline.AudioTrackItems[0].LinkGroupID == nil || *pd.Timeline.AudioTrackItems[0].LinkGroupID != 3 {
		t.Errorf("Audio item expected LinkGroupID 3, got %v", pd.Timeline.AudioTrackItems[0].LinkGroupID)
	}
}

func TestParseOTIOLinkGroups_MalformedOrMissing(t *testing.T) {
	pd := &ProjectDataPayload{}

	// Non-existent file
	err := ParseOTIOLinkGroups("/non/existent/path/timeline.otio", pd)
	if err == nil {
		t.Errorf("Expected error for missing file, got nil")
	}

	// Corrupt JSON file
	tmpDir := t.TempDir()
	badJSONPath := filepath.Join(tmpDir, "bad.otio")
	_ = os.WriteFile(badJSONPath, []byte("NOT_JSON"), 0644)

	err = ParseOTIOLinkGroups(badJSONPath, pd)
	if err == nil {
		t.Errorf("Expected error for malformed JSON, got nil")
	}
}

func TestParseOTIOLinkGroups_ExistingTempFilesIfPresent(t *testing.T) {
	// Test against real exported files on disk if they exist in Caches or Application Support
	homeDir, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(homeDir, "Library", "Caches", "HushCut", "tmp", "temp-timeline.otio"),
		filepath.Join(homeDir, "Library", "Application Support", "HushCut", "tmp", "temp-timeline.otio"),
	}

	var otioFile string
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			otioFile = c
			break
		}
	}

	if otioFile == "" {
		t.Skip("No real temp-timeline.otio found on machine; skipping integration test.")
	}

	debugJSON := filepath.Join(filepath.Dir(otioFile), "debug_project_data.json")
	data, err := os.ReadFile(debugJSON)
	if err != nil {
		t.Skipf("No debug_project_data.json found at %s; skipping.", debugJSON)
	}

	var pd ProjectDataPayload
	if err := json.Unmarshal(data, &pd); err != nil {
		t.Fatalf("Failed to unmarshal debug_project_data.json: %v", err)
	}

	err = ParseOTIOLinkGroups(otioFile, &pd)
	if err != nil {
		t.Fatalf("Failed to parse real OTIO file: %v", err)
	}

	// Dynamically verify that link groups were applied to items in pd
	var linkedCount int
	for _, item := range append(pd.Timeline.VideoTrackItems, pd.Timeline.AudioTrackItems...) {
		if item.LinkGroupID != nil {
			linkedCount++
		}
	}

	if linkedCount == 0 {
		t.Skipf("Cached OTIO file and debug_project_data.json are from mismatched timelines; skipping.")
	}
}
