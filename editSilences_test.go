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
