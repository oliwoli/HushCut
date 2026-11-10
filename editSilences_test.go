package main

import (
	"math"
	"testing"
)

func TestCreateEditsWithOptionalSilence_FinalSegmentKeptWhenRemovingSilence(t *testing.T) {
	// 60 fps clip of 1000 frames (approx 16.6 seconds)
	// Silences at:
	// 100..200
	// 500..600
	// After 600, sound continues until 1000.
	clip := ClipData{
		SourceStartFrame: 0,
		SourceEndFrame:   1000,
		StartFrame:       0,
		EndFrame:         1000,
	}
	silences := []SilenceInterval{
		{Start: 100, End: 200},
		{Start: 500, End: 600},
	}

	fps := 60.0
	edits := CreateEditsWithOptionalSilence(clip, silences, fps, fps, false)

	// Should have 3 sound segments:
	// Segment 1: 0..100
	// Segment 2: 200..500
	// Segment 3: 600..1000 (THIS MUST NOT BE DROPPED!)
	if len(edits) != 3 {
		t.Fatalf("Expected 3 edits when removing silences, got %d", len(edits))
	}

	// Verify timeline contiguity (no black gaps)
	for i := 0; i < len(edits)-1; i++ {
		if edits[i+1].StartFrame != edits[i].EndFrame {
			t.Errorf("Timeline gap between edit %d and %d: end=%.2f, next start=%.2f",
				i, i+1, edits[i].EndFrame, edits[i+1].StartFrame)
		}
	}

	// Verify the last edit covers up to clip end
	lastEdit := edits[len(edits)-1]
	if math.Abs(lastEdit.SourceEndFrame-clip.SourceEndFrame) > 1.0 {
		t.Errorf("Expected last edit SourceEndFrame near %.2f, got %.2f",
			clip.SourceEndFrame, lastEdit.SourceEndFrame)
	}
}

func TestCreateEditsWithOptionalSilence_PreserveSilencesContiguity(t *testing.T) {
	clip := ClipData{
		SourceStartFrame: 0,
		SourceEndFrame:   1000,
		StartFrame:       0,
		EndFrame:         1000,
	}
	silences := []SilenceInterval{
		{Start: 100, End: 200},
		{Start: 500, End: 600},
	}

	fps := 60.0
	edits := CreateEditsWithOptionalSilence(clip, silences, fps, fps, true)

	// Should have 5 segments alternating sound and silence:
	// 1: Sound (0..100)
	// 2: Silence (100..200)
	// 3: Sound (200..500)
	// 4: Silence (500..600)
	// 5: Sound (600..1000)
	if len(edits) != 5 {
		t.Fatalf("Expected 5 edits in preserve silences mode, got %d", len(edits))
	}

	// Check total timeline duration matches original clip
	if edits[0].StartFrame != clip.StartFrame {
		t.Errorf("First startFrame = %.2f, expected %.2f", edits[0].StartFrame, clip.StartFrame)
	}
	if edits[len(edits)-1].EndFrame != clip.EndFrame {
		t.Errorf("Last endFrame = %.2f, expected %.2f", edits[len(edits)-1].EndFrame, clip.EndFrame)
	}

	// Check through-edit requirement: adjacent source frames must match exactly!
	for i := 0; i < len(edits)-1; i++ {
		if edits[i+1].StartFrame != edits[i].EndFrame {
			t.Errorf("Timeline gap between edit %d and %d: end=%.2f, next start=%.2f",
				i, i+1, edits[i].EndFrame, edits[i+1].StartFrame)
		}
		if edits[i+1].SourceStartFrame != edits[i].SourceEndFrame {
			t.Errorf("Source frames not adjacent between edit %d and %d: end=%.6f, next start=%.6f (diff=%.6f)",
				i, i+1, edits[i].SourceEndFrame, edits[i+1].SourceStartFrame,
				edits[i+1].SourceStartFrame-edits[i].SourceEndFrame)
		}
	}
}

func TestCreateEditsWithOptionalSilence_MismatchedFramerate_NoGaps(t *testing.T) {
	// Source is 59.94 fps, Timeline is 24.0 fps
	sourceFPS := 59.94
	timelineFPS := 24.0

	// 10 seconds of source media = 599.4 source frames, 240 timeline frames
	clip := ClipData{
		SourceStartFrame: 0,
		SourceEndFrame:   599.4,
		StartFrame:       0,
		EndFrame:         240,
	}

	silences := []SilenceInterval{
		{Start: 59.94, End: 119.88},  // 1s to 2s
		{Start: 239.76, End: 359.64}, // 4s to 6s
	}

	for _, keepSilence := range []bool{false, true} {
		edits := CreateEditsWithOptionalSilence(clip, silences, sourceFPS, timelineFPS, keepSilence)

		if len(edits) == 0 {
			t.Fatalf("keepSilence=%v: expected edits, got 0", keepSilence)
		}

		// Verify zero timeline gaps between all edits
		for i := 0; i < len(edits)-1; i++ {
			if edits[i+1].StartFrame != edits[i].EndFrame {
				t.Errorf("keepSilence=%v: Timeline gap between edit %d and %d: end=%.2f, next start=%.2f",
					keepSilence, i, i+1, edits[i].EndFrame, edits[i+1].StartFrame)
			}
		}

		// Verify every edit has positive duration
		for i, edit := range edits {
			tlDur := edit.EndFrame - edit.StartFrame
			srcDur := edit.SourceEndFrame - edit.SourceStartFrame
			if tlDur <= 0 {
				t.Errorf("keepSilence=%v: Edit %d has non-positive timeline duration %.2f", keepSilence, i, tlDur)
			}
			if srcDur <= 0 {
				t.Errorf("keepSilence=%v: Edit %d has non-positive source duration %.2f", keepSilence, i, srcDur)
			}
		}
	}
}

func TestCalculateAndStoreEditsForTimeline_MultiTrack_PreserveSilencesAndUnlinked(t *testing.T) {
	app := &App{}

	// Setup a timeline with:
	// - 1 Video item (linked group 1)
	// - 1 Audio item (linked group 1)
	// - 2 Audio items unlinked (link_group_id == nil)
	linkGroup1 := 1
	pd := ProjectDataPayload{
		Timeline: Timeline{
			Name:       "Test Timeline",
			FPS:        60.0,
			ProjectFPS: 60.0,
			VideoTrackItems: []TimelineItem{
				{
					ID:               "v1_item",
					Name:             "camera.mov",
					TrackIndex:       1,
					TrackType:        "video",
					StartFrame:       1000,
					EndFrame:         3000,
					SourceStartFrame: 0,
					SourceEndFrame:   2000,
					SourceFPS:        60.0,
					LinkGroupID:      &linkGroup1,
				},
			},
			AudioTrackItems: []TimelineItem{
				{
					ID:               "a1_linked",
					Name:             "camera.mov",
					TrackIndex:       1,
					TrackType:        "audio",
					StartFrame:       1000,
					EndFrame:         3000,
					SourceStartFrame: 0,
					SourceEndFrame:   2000,
					SourceFPS:        60.0,
					LinkGroupID:      &linkGroup1,
				},
				{
					ID:               "a2_unlinked",
					Name:             "mic1.wav",
					TrackIndex:       2,
					TrackType:        "audio",
					StartFrame:       1000,
					EndFrame:         3000,
					SourceStartFrame: 0,
					SourceEndFrame:   2000,
					SourceFPS:        60.0,
					LinkGroupID:      nil, // unlinked
				},
				{
					ID:               "a3_unlinked",
					Name:             "mic2.wav",
					TrackIndex:       3,
					TrackType:        "audio",
					StartFrame:       1000,
					EndFrame:         3000,
					SourceStartFrame: 0,
					SourceEndFrame:   2000,
					SourceFPS:        60.0,
					LinkGroupID:      nil, // unlinked
				},
			},
		},
	}

	silencesMap := map[string][]SilencePeriod{
		"a1_linked": {
			{Start: 2.0, End: 5.0},   // 120 frames to 300 frames
			{Start: 10.0, End: 15.0}, // 600 frames to 900 frames
		},
		"a2_unlinked": {
			{Start: 4.0, End: 8.0}, // 240 frames to 480 frames
		},
	}

	// 1. TEST PRESERVE SILENCES MODE
	resPreserve, err := app.CalculateAndStoreEditsForTimeline(pd, true, silencesMap)
	if err != nil {
		t.Fatalf("CalculateAndStoreEditsForTimeline failed: %v", err)
	}

	// Unlinked items must STAY unlinked (nil)
	if resPreserve.Timeline.AudioTrackItems[1].LinkGroupID != nil {
		t.Errorf("Expected a2_unlinked LinkGroupID to be nil, got %v", *resPreserve.Timeline.AudioTrackItems[1].LinkGroupID)
	}
	if resPreserve.Timeline.AudioTrackItems[2].LinkGroupID != nil {
		t.Errorf("Expected a3_unlinked LinkGroupID to be nil, got %v", *resPreserve.Timeline.AudioTrackItems[2].LinkGroupID)
	}

	// Linked item must keep its group ID
	if resPreserve.Timeline.AudioTrackItems[0].LinkGroupID == nil || *resPreserve.Timeline.AudioTrackItems[0].LinkGroupID != 1 {
		t.Errorf("Expected a1_linked LinkGroupID to be 1, got %v", resPreserve.Timeline.AudioTrackItems[0].LinkGroupID)
	}

	// Verify a1_linked edits in preserve mode
	a1Edits := resPreserve.Timeline.AudioTrackItems[0].EditInstructions
	if len(a1Edits) != 5 {
		t.Fatalf("Expected 5 edits for a1_linked in preserve mode, got %d", len(a1Edits))
	}

	// Check timeline contiguity (zero gaps) AND through-edit adjacent source frames
	for i := 0; i < len(a1Edits)-1; i++ {
		if a1Edits[i+1].StartFrame != a1Edits[i].EndFrame {
			t.Errorf("Timeline gap at edit %d: end=%.2f, next start=%.2f", i, a1Edits[i].EndFrame, a1Edits[i+1].StartFrame)
		}
		if a1Edits[i+1].SourceStartFrame != a1Edits[i].SourceEndFrame {
			t.Errorf("Source frames not adjacent at edit %d: end=%.6f, next start=%.6f",
				i, a1Edits[i].SourceEndFrame, a1Edits[i+1].SourceStartFrame)
		}
	}

	// Check total timeline duration preserved
	origDur := pd.Timeline.AudioTrackItems[0].EndFrame - pd.Timeline.AudioTrackItems[0].StartFrame
	totalDur := a1Edits[len(a1Edits)-1].EndFrame - a1Edits[0].StartFrame
	if math.Abs(totalDur-origDur) > 0.01 {
		t.Errorf("Preserve mode duration mismatch: expected %.2f, got %.2f", origDur, totalDur)
	}

	// Check Enabled flags alternate between true (sound) and false (silence)
	expectedEnabled := []bool{true, false, true, false, true}
	for i, edit := range a1Edits {
		if edit.Enabled != expectedEnabled[i] {
			t.Errorf("Edit %d enabled expected %v, got %v", i, expectedEnabled[i], edit.Enabled)
		}
	}

	// 2. TEST NORMAL MODE (SILENCES REMOVED)
	resNormal, err := app.CalculateAndStoreEditsForTimeline(pd, false, silencesMap)
	if err != nil {
		t.Fatalf("CalculateAndStoreEditsForTimeline (normal) failed: %v", err)
	}

	a1NormalEdits := resNormal.Timeline.AudioTrackItems[0].EditInstructions
	if len(a1NormalEdits) != 3 {
		t.Fatalf("Expected 3 sound edits in normal mode, got %d", len(a1NormalEdits))
	}

	// In normal mode: zero timeline gaps between remaining clips
	for i := 0; i < len(a1NormalEdits)-1; i++ {
		if a1NormalEdits[i+1].StartFrame != a1NormalEdits[i].EndFrame {
			t.Errorf("Normal mode timeline gap at edit %d: end=%.2f, next start=%.2f",
				i, a1NormalEdits[i].EndFrame, a1NormalEdits[i+1].StartFrame)
		}
	}

	// All normal mode edits must be Enabled=true
	for i, edit := range a1NormalEdits {
		if !edit.Enabled {
			t.Errorf("Normal mode edit %d should be enabled, got false", i)
		}
	}

	// Duration should be shorter than original by the silence durations
	normalDur := a1NormalEdits[len(a1NormalEdits)-1].EndFrame - a1NormalEdits[0].StartFrame
	if normalDur >= origDur {
		t.Errorf("Normal mode duration should be less than original (%.2f), got %.2f", origDur, normalDur)
	}
}
