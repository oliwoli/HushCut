package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// AudioMixInput represents an audio clip input segment to be mixed down.
type AudioMixInput struct {
	ProcessedFileName string
	SourceStartFrame  float64
	Duration          float64
	StartFrame        float64 // Relative to mixdown base frame
}

// ComputeLinkedAudioHash creates a deterministic, content-addressed hash for any collection of audio items.
// The hash is based on:
// 1. Constituent item IDs
// 2. Individual source files and source ranges (SourceStartFrame, Duration)
// 3. Relative placement on the timeline (StartFrame - baseStartFrame)
//
// This enables deterministic caching for full groups as well as any sub-selection of clips within a group.
func ComputeLinkedAudioHash(items []TimelineItem) string {
	if len(items) == 0 {
		return ""
	}

	minStart := items[0].StartFrame
	for _, it := range items {
		if it.StartFrame < minStart {
			minStart = it.StartFrame
		}
	}

	// Make a sorted copy of items for canonical ordering
	sortedItems := make([]TimelineItem, len(items))
	copy(sortedItems, items)
	sort.Slice(sortedItems, func(i, j int) bool {
		if sortedItems[i].TrackIndex != sortedItems[j].TrackIndex {
			return sortedItems[i].TrackIndex < sortedItems[j].TrackIndex
		}
		if sortedItems[i].StartFrame != sortedItems[j].StartFrame {
			return sortedItems[i].StartFrame < sortedItems[j].StartFrame
		}
		return sortedItems[i].ID < sortedItems[j].ID
	})

	var b strings.Builder
	b.WriteString("v1;")
	for _, it := range sortedItems {
		relStart := it.StartFrame - minStart
		pName := ""
		if it.ProcessedFileName != nil {
			pName = *it.ProcessedFileName
		}
		fmt.Fprintf(&b, "%s:%s:%.4f:%.4f:%.4f;", it.ID, pName, it.SourceStartFrame, it.Duration, relStart)
	}

	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:8]) // 16-hex characters
}

// EnrichLinkedAudioGroups populates LinkedAudioGroups and GroupProcessedFileName on pd.
// It groups audio items with the same LinkGroupID when the group contains 2 or more audio items.
func EnrichLinkedAudioGroups(pd *ProjectDataPayload) {
	if pd == nil || len(pd.Timeline.AudioTrackItems) == 0 {
		return
	}

	// Group audio items by LinkGroupID
	groupMap := make(map[int][]int) // groupID -> slice of indices in AudioTrackItems
	for i, item := range pd.Timeline.AudioTrackItems {
		if item.LinkGroupID != nil {
			groupMap[*item.LinkGroupID] = append(groupMap[*item.LinkGroupID], i)
		}
	}

	if pd.Timeline.LinkedAudioGroups == nil {
		pd.Timeline.LinkedAudioGroups = make(map[int]*LinkedAudioGroup)
	}

	for groupID, indices := range groupMap {
		// Only create combined groups when there are 2 or more audio items
		if len(indices) <= 1 {
			continue
		}

		groupItems := make([]TimelineItem, len(indices))
		for k, idx := range indices {
			groupItems[k] = pd.Timeline.AudioTrackItems[idx]
		}

		minStart := groupItems[0].StartFrame
		maxEnd := groupItems[0].EndFrame
		trackSet := make(map[int]bool)
		itemIDs := make([]string, 0, len(groupItems))

		for _, it := range groupItems {
			if it.StartFrame < minStart {
				minStart = it.StartFrame
			}
			if it.EndFrame > maxEnd {
				maxEnd = it.EndFrame
			}
			trackSet[it.TrackIndex] = true
			itemIDs = append(itemIDs, it.ID)
		}

		trackIndices := make([]int, 0, len(trackSet))
		for t := range trackSet {
			trackIndices = append(trackIndices, t)
		}
		sort.Ints(trackIndices)

		hashStr := ComputeLinkedAudioHash(groupItems)
		processedName := fmt.Sprintf("linkgroup_%d_%s.wav", groupID, hashStr)

		pd.Timeline.LinkedAudioGroups[groupID] = &LinkedAudioGroup{
			GroupID:           groupID,
			ProcessedFileName: processedName,
			StartFrame:        minStart,
			EndFrame:          maxEnd,
			Duration:          maxEnd - minStart,
			TrackIndices:      trackIndices,
			ItemIDs:           itemIDs,
		}

		// Update each item in pd with the group's processed filename
		for _, idx := range indices {
			nameCopy := processedName
			pd.Timeline.AudioTrackItems[idx].GroupProcessedFileName = &nameCopy
		}
	}
}

// MixdownLinkedAudio pre-renders mixdowns for all multi-audio link groups in projectData.
func (a *App) MixdownLinkedAudio(projectData ProjectDataPayload) error {
	if len(projectData.Timeline.LinkedAudioGroups) == 0 {
		EnrichLinkedAudioGroups(&projectData)
	}
	if len(projectData.Timeline.LinkedAudioGroups) == 0 {
		return nil
	}

	fps := projectData.Timeline.FPS
	if fps <= 0 {
		fps = 30.0
	}

	// Map each group ID to its audio items
	groupItemsMap := make(map[int][]TimelineItem)
	for _, item := range projectData.Timeline.AudioTrackItems {
		if item.LinkGroupID != nil && projectData.Timeline.LinkedAudioGroups[*item.LinkGroupID] != nil {
			groupItemsMap[*item.LinkGroupID] = append(groupItemsMap[*item.LinkGroupID], item)
		}
	}

	log.Printf("Starting mixdown of %d linked audio group(s)...", len(projectData.Timeline.LinkedAudioGroups))
	for groupID, group := range projectData.Timeline.LinkedAudioGroups {
		items := groupItemsMap[groupID]
		if len(items) <= 1 {
			continue
		}
		outputPath := filepath.Join(a.tmpPath, group.ProcessedFileName)
		a.updateFileUsage(outputPath)
		a.ExecuteAndTrackLinkedMixdown(fps, outputPath, items)
	}

	return nil
}

// isLinkedAudioFile returns true if the filename represents a linked audio mixdown.
func (a *App) isLinkedAudioFile(path string) bool {
	base := filepath.Base(path)
	return strings.HasPrefix(base, "linkgroup_") && strings.HasSuffix(base, ".wav")
}

// EnsureLinkedAudioMixdown guarantees that a linked audio mixdown file is rendered and available on disk.
func (a *App) EnsureLinkedAudioMixdown(path string) error {
	base := filepath.Base(path)
	outputPath := filepath.Join(a.tmpPath, base)

	// If already tracked as running, wait for it
	if err := a.WaitForFile(outputPath); err != nil {
		return err
	}

	// If already on disk and valid, return immediately
	if isValidWavFile(outputPath) {
		return nil
	}

	// Filename format: linkgroup_{groupId}_{hash}.wav
	parts := strings.Split(base, "_")
	if len(parts) < 3 {
		return fmt.Errorf("invalid linked audio filename format: %s", base)
	}
	groupID, err := strconv.Atoi(parts[1])
	if err != nil {
		return fmt.Errorf("failed to parse group ID from %s: %w", base, err)
	}

	var pd *ProjectDataPayload
	session := a.GetActiveTimelineSession()
	if session != nil && session.Data != nil {
		pd = session.Data
	} else {
		a.currentProjectMu.RLock()
		pd = a.currentProject
		a.currentProjectMu.RUnlock()
	}
	if pd == nil {
		return fmt.Errorf("no active project data to ensure mixdown for %s", base)
	}

	var items []TimelineItem
	for _, it := range pd.Timeline.AudioTrackItems {
		if it.LinkGroupID != nil && *it.LinkGroupID == groupID {
			items = append(items, it)
		}
	}
	if len(items) <= 1 {
		return fmt.Errorf("group %d has %d items, cannot mixdown", groupID, len(items))
	}

	fps := pd.Timeline.FPS
	if fps <= 0 {
		fps = 30.0
	}

	a.updateFileUsage(outputPath)
	a.ExecuteAndTrackLinkedMixdown(fps, outputPath, items)

	return a.WaitForFile(outputPath)
}

// ExecuteAndTrackLinkedMixdown runs the mixdown in a background goroutine with progress tracking.
func (a *App) ExecuteAndTrackLinkedMixdown(fps float64, outputPath string, items []TimelineItem) {
	tracker := &ProgressTracker{Done: make(chan error, 1)}
	if _, loaded := a.progressTracker.LoadOrStore(outputPath, tracker); loaded {
		return // Job is already running.
	}

	go func() {
		defer func() {
			close(tracker.Done)
			a.progressTracker.Delete(outputPath)
		}()

		a.emitEvent("conversion:progress", ProgressStatus{FilePath: outputPath, Percentage: 10})
		a.ffmpegSemaphore <- struct{}{}
		defer func() { <-a.ffmpegSemaphore }()

		var err error
		if !isValidWavFile(outputPath) {
			err = a.ExecuteTimelineItemsMixdown(fps, outputPath, items)
		}
		if err != nil {
			log.Printf("Error rendering linked mixdown for %s: %v", filepath.Base(outputPath), err)
			a.emitEvent("conversion:error", ProgressStatus{FilePath: outputPath, Percentage: 0, Error: err.Error()})
		} else {
			a.emitEvent("conversion:done", ProgressStatus{FilePath: outputPath, Percentage: 100})
		}
		tracker.Done <- err
	}()
}

// ExecuteTimelineItemsMixdown converts TimelineItems into AudioMixInputs and invokes executeAudioMix.
func (a *App) ExecuteTimelineItemsMixdown(fps float64, outputPath string, items []TimelineItem) error {
	if len(items) == 0 {
		return fmt.Errorf("no items provided for mixdown")
	}

	minStart := items[0].StartFrame
	for _, it := range items {
		if it.StartFrame < minStart {
			minStart = it.StartFrame
		}
	}

	inputs := make([]AudioMixInput, 0, len(items))
	for _, it := range items {
		if it.ProcessedFileName == nil || *it.ProcessedFileName == "" {
			continue
		}
		inputs = append(inputs, AudioMixInput{
			ProcessedFileName: *it.ProcessedFileName,
			SourceStartFrame:  it.SourceStartFrame,
			Duration:          it.Duration,
			StartFrame:        it.StartFrame - minStart,
		})
	}

	return a.executeAudioMix(fps, outputPath, inputs)
}

// GetOrRenderMixdown returns (and if necessary renders) the mixdown for any arbitrary subset of items.
// This allows previewing selections of clips within a group dynamically.
func (a *App) GetOrRenderMixdown(itemIDs []string) (*LinkedAudioGroup, error) {
	if len(itemIDs) == 0 {
		return nil, fmt.Errorf("no item IDs provided")
	}

	session := a.GetActiveTimelineSession()
	if session == nil || session.Data == nil {
		return nil, fmt.Errorf("no active project data session")
	}

	idMap := make(map[string]bool)
	for _, id := range itemIDs {
		idMap[id] = true
	}

	var selectedItems []TimelineItem
	for _, it := range session.Data.Timeline.AudioTrackItems {
		if idMap[it.ID] {
			selectedItems = append(selectedItems, it)
		}
	}

	if len(selectedItems) == 0 {
		return nil, fmt.Errorf("no matching timeline items found for IDs: %v", itemIDs)
	}

	minStart := selectedItems[0].StartFrame
	maxEnd := selectedItems[0].EndFrame
	trackSet := make(map[int]bool)
	matchedIDs := make([]string, 0, len(selectedItems))

	for _, it := range selectedItems {
		if it.StartFrame < minStart {
			minStart = it.StartFrame
		}
		if it.EndFrame > maxEnd {
			maxEnd = it.EndFrame
		}
		trackSet[it.TrackIndex] = true
		matchedIDs = append(matchedIDs, it.ID)
	}

	trackIndices := make([]int, 0, len(trackSet))
	for t := range trackSet {
		trackIndices = append(trackIndices, t)
	}
	sort.Ints(trackIndices)

	var groupID int
	if selectedItems[0].LinkGroupID != nil {
		groupID = *selectedItems[0].LinkGroupID
	}

	// Single item case: no mixdown needed
	if len(selectedItems) == 1 {
		pName := ""
		if selectedItems[0].ProcessedFileName != nil {
			pName = *selectedItems[0].ProcessedFileName
		}
		return &LinkedAudioGroup{
			GroupID:           groupID,
			ProcessedFileName: pName,
			StartFrame:        minStart,
			EndFrame:          maxEnd,
			Duration:          maxEnd - minStart,
			TrackIndices:      trackIndices,
			ItemIDs:           matchedIDs,
		}, nil
	}

	// Multi-item case: compute deterministic hash and mixdown
	hashStr := ComputeLinkedAudioHash(selectedItems)
	processedName := fmt.Sprintf("linkgroup_%d_%s.wav", groupID, hashStr)
	outputPath := filepath.Join(a.tmpPath, processedName)

	fps := session.Data.Timeline.FPS
	if fps <= 0 {
		fps = 30.0
	}

	a.updateFileUsage(outputPath)
	if !isValidWavFile(outputPath) {
		if err := a.ExecuteTimelineItemsMixdown(fps, outputPath, selectedItems); err != nil {
			return nil, fmt.Errorf("failed to mixdown selected items: %w", err)
		}
	}

	return &LinkedAudioGroup{
		GroupID:           groupID,
		ProcessedFileName: processedName,
		StartFrame:        minStart,
		EndFrame:          maxEnd,
		Duration:          maxEnd - minStart,
		TrackIndices:      trackIndices,
		ItemIDs:           matchedIDs,
	}, nil
}
