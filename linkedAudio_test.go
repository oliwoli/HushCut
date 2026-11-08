package main

import (
	"testing"
)

func TestComputeLinkedAudioHash_Deterministic(t *testing.T) {
	proc1 := "proc1.wav"
	proc2 := "proc2.wav"

	itemsA := []TimelineItem{
		{ID: "item1", TrackIndex: 1, StartFrame: 100, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc1},
		{ID: "item2", TrackIndex: 2, StartFrame: 100, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc2},
	}

	// Reverse order input
	itemsB := []TimelineItem{
		{ID: "item2", TrackIndex: 2, StartFrame: 100, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc2},
		{ID: "item1", TrackIndex: 1, StartFrame: 100, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc1},
	}

	hashA := ComputeLinkedAudioHash(itemsA)
	hashB := ComputeLinkedAudioHash(itemsB)

	if hashA == "" {
		t.Fatal("Expected non-empty hash")
	}
	if hashA != hashB {
		t.Fatalf("Expected deterministic hash regardless of slice order, got %s vs %s", hashA, hashB)
	}

	// Change start frame
	itemsC := []TimelineItem{
		{ID: "item1", TrackIndex: 1, StartFrame: 100, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc1},
		{ID: "item2", TrackIndex: 2, StartFrame: 150, Duration: 50, SourceStartFrame: 0, ProcessedFileName: &proc2},
	}
	hashC := ComputeLinkedAudioHash(itemsC)
	if hashC == hashA {
		t.Fatalf("Expected different hash for shifted item, both were %s", hashA)
	}
}

func TestComputeLinkedAudioHash_SubSelection(t *testing.T) {
	proc1 := "c1.wav"
	proc2 := "c2.wav"
	proc3 := "c3.wav"
	proc4 := "c4.wav"

	c1 := TimelineItem{ID: "c1", TrackIndex: 1, StartFrame: 0, Duration: 100, ProcessedFileName: &proc1}
	c2 := TimelineItem{ID: "c2", TrackIndex: 2, StartFrame: 0, Duration: 100, ProcessedFileName: &proc2}
	c3 := TimelineItem{ID: "c3", TrackIndex: 3, StartFrame: 0, Duration: 100, ProcessedFileName: &proc3}
	c4 := TimelineItem{ID: "c4", TrackIndex: 4, StartFrame: 0, Duration: 100, ProcessedFileName: &proc4}

	all4Hash := ComputeLinkedAudioHash([]TimelineItem{c1, c2, c3, c4})
	sub12Hash := ComputeLinkedAudioHash([]TimelineItem{c1, c2})
	sub34Hash := ComputeLinkedAudioHash([]TimelineItem{c3, c4})

	if all4Hash == sub12Hash || all4Hash == sub34Hash || sub12Hash == sub34Hash {
		t.Fatalf("Sub-selections must produce distinct hashes: all=%s, 12=%s, 34=%s", all4Hash, sub12Hash, sub34Hash)
	}
}

func TestEnrichLinkedAudioGroups(t *testing.T) {
	group1 := 1 // Video + 1 Audio: should NOT produce a LinkedAudioGroup
	group2 := 2 // 3 Audio tracks linked: should produce LinkedAudioGroup

	procV1 := "v1.mov"
	procA1 := "a1.wav"
	procA2_1 := "a2_1.wav"
	procA2_2 := "a2_2.wav"
	procA2_3 := "a2_3.wav"
	procUnlinked := "unlinked.wav"

	pd := &ProjectDataPayload{
		Timeline: Timeline{
			VideoTrackItems: []TimelineItem{
				{ID: "v1", TrackIndex: 1, StartFrame: 0, EndFrame: 100, LinkGroupID: &group1, ProcessedFileName: &procV1},
			},
			AudioTrackItems: []TimelineItem{
				// Group 1 (only 1 audio item linked to video)
				{ID: "a1", TrackIndex: 1, StartFrame: 0, EndFrame: 100, LinkGroupID: &group1, ProcessedFileName: &procA1},

				// Group 2 (3 audio items linked together)
				{ID: "a2_1", TrackIndex: 1, StartFrame: 200, EndFrame: 400, LinkGroupID: &group2, ProcessedFileName: &procA2_1},
				{ID: "a2_2", TrackIndex: 2, StartFrame: 200, EndFrame: 400, LinkGroupID: &group2, ProcessedFileName: &procA2_2},
				{ID: "a2_3", TrackIndex: 3, StartFrame: 200, EndFrame: 450, LinkGroupID: &group2, ProcessedFileName: &procA2_3},

				// Unlinked item
				{ID: "a_unlinked", TrackIndex: 1, StartFrame: 500, EndFrame: 600, LinkGroupID: nil, ProcessedFileName: &procUnlinked},
			},
		},
	}

	EnrichLinkedAudioGroups(pd)

	// Group 1 has only 1 audio item -> should NOT be in LinkedAudioGroups
	if _, exists := pd.Timeline.LinkedAudioGroups[group1]; exists {
		t.Errorf("Group 1 has only 1 audio item; expected it NOT to be in LinkedAudioGroups")
	}
	if pd.Timeline.AudioTrackItems[0].GroupProcessedFileName != nil {
		t.Errorf("Group 1 single audio item should not have GroupProcessedFileName set")
	}

	// Group 2 has 3 audio items -> SHOULD be in LinkedAudioGroups
	g2, exists := pd.Timeline.LinkedAudioGroups[group2]
	if !exists {
		t.Fatalf("Group 2 (3 audio items) expected in LinkedAudioGroups, but not found")
	}

	if g2.StartFrame != 200 {
		t.Errorf("Expected StartFrame 200, got %f", g2.StartFrame)
	}
	if g2.EndFrame != 450 {
		t.Errorf("Expected EndFrame 450, got %f", g2.EndFrame)
	}
	if g2.Duration != 250 {
		t.Errorf("Expected Duration 250, got %f", g2.Duration)
	}
	if len(g2.TrackIndices) != 3 || g2.TrackIndices[0] != 1 || g2.TrackIndices[1] != 2 || g2.TrackIndices[2] != 3 {
		t.Errorf("Expected TrackIndices [1 2 3], got %v", g2.TrackIndices)
	}
	if len(g2.ItemIDs) != 3 {
		t.Errorf("Expected 3 ItemIDs, got %v", g2.ItemIDs)
	}

	// Verify each group 2 item has GroupProcessedFileName set
	for _, idx := range []int{1, 2, 3} {
		item := pd.Timeline.AudioTrackItems[idx]
		if item.GroupProcessedFileName == nil || *item.GroupProcessedFileName != g2.ProcessedFileName {
			t.Errorf("Item %s: expected GroupProcessedFileName %s, got %v", item.ID, g2.ProcessedFileName, item.GroupProcessedFileName)
		}
	}

	// Unlinked item should have nil GroupProcessedFileName
	if pd.Timeline.AudioTrackItems[4].GroupProcessedFileName != nil {
		t.Errorf("Unlinked item should have nil GroupProcessedFileName")
	}
}
