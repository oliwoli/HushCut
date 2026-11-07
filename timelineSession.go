package main

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
)

// TimelineKind indicates whether the timeline is linked to DaVinci Resolve or is standalone.
type TimelineKind string

const (
	TimelineKindDaVinci    TimelineKind = "davinci"
	TimelineKindStandalone TimelineKind = "standalone"
)

// DaVinciSyncInfo holds sync metadata when a timeline is tethered to DaVinci Resolve.
type DaVinciSyncInfo struct {
	ProjectName  string `json:"project_name"`
	TimelineName string `json:"timeline_name"`
	TimelineUID  string `json:"timeline_uid,omitempty"`
	LastSyncedAt int64  `json:"last_synced_at"`
	IsConnected  bool   `json:"is_connected"`
}

// TimelineSource describes the origin and connection type of a timeline.
type TimelineSource struct {
	Kind    TimelineKind     `json:"kind"`
	DaVinci *DaVinciSyncInfo `json:"davinci,omitempty"`
}

// TimelineSession represents an open timeline session in memory.
type TimelineSession struct {
	ID            string              `json:"id"`
	Name          string              `json:"name"`
	Source        TimelineSource      `json:"source"`
	Data          *ProjectDataPayload `json:"data"`
	OTIOReadyChan chan struct{}       `json:"-"`
	IsDirty       bool                `json:"is_dirty"`
	CreatedAt     time.Time           `json:"created_at"`
	UpdatedAt     time.Time           `json:"updated_at"`
}

// TimelineSessionSummary is a lightweight representation for UI tab bars and selectors.
type TimelineSessionSummary struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Source      TimelineSource `json:"source"`
	IsDirty     bool           `json:"is_dirty"`
	IsActive    bool           `json:"is_active"`
	ClipCount   int            `json:"clip_count"`
	DurationSec float64        `json:"duration_sec"`
	FPS         float64        `json:"fps"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

// Summary creates a summary representation of the timeline session.
func (s *TimelineSession) Summary(isActive bool) TimelineSessionSummary {
	var clipCount int
	var durationSec float64
	var fps float64 = 30.0

	if s.Data != nil {
		fps = s.Data.Timeline.FPS
		if fps <= 0 {
			fps = 30.0
		}
		clipCount = len(s.Data.Timeline.AudioTrackItems) + len(s.Data.Timeline.VideoTrackItems)

		var maxEndFrame float64
		for _, item := range s.Data.Timeline.AudioTrackItems {
			if item.EndFrame > maxEndFrame {
				maxEndFrame = item.EndFrame
			}
		}
		for _, item := range s.Data.Timeline.VideoTrackItems {
			if item.EndFrame > maxEndFrame {
				maxEndFrame = item.EndFrame
			}
		}
		durationSec = maxEndFrame / fps
	}

	return TimelineSessionSummary{
		ID:          s.ID,
		Name:        s.Name,
		Source:      s.Source,
		IsDirty:     s.IsDirty,
		IsActive:    isActive,
		ClipCount:   clipCount,
		DurationSec: durationSec,
		FPS:         fps,
		UpdatedAt:   s.UpdatedAt,
	}
}

// deepCopyProjectData performs a full deep copy of a ProjectDataPayload via JSON.
func deepCopyProjectData(src *ProjectDataPayload) (*ProjectDataPayload, error) {
	if src == nil {
		return nil, nil
	}
	bytes, err := json.Marshal(src)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal project data for deep copy: %w", err)
	}
	var dst ProjectDataPayload
	if err := json.Unmarshal(bytes, &dst); err != nil {
		return nil, fmt.Errorf("failed to unmarshal project data for deep copy: %w", err)
	}
	return &dst, nil
}

// UpsertDaVinciSession stores or updates a DaVinci timeline session in memory and marks it active.
func (a *App) UpsertDaVinciSession(pd *ProjectDataPayload, otioChan chan struct{}) *TimelineSession {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	if a.timelineSessions == nil {
		a.timelineSessions = make(map[string]*TimelineSession)
	}

	now := time.Now()
	projectName := ""
	timelineName := "Untitled Timeline"
	if pd != nil {
		projectName = pd.ProjectName
		if pd.Timeline.Name != "" {
			timelineName = pd.Timeline.Name
		}
	}

	// Check if a session already exists for this DaVinci project & timeline
	var existingSession *TimelineSession
	for _, s := range a.timelineSessions {
		if s.Source.Kind == TimelineKindDaVinci && s.Source.DaVinci != nil {
			if s.Source.DaVinci.ProjectName == projectName && s.Source.DaVinci.TimelineName == timelineName {
				existingSession = s
				break
			}
		}
	}

	if existingSession != nil {
		existingSession.Data = pd
		existingSession.Name = timelineName
		existingSession.OTIOReadyChan = otioChan
		existingSession.UpdatedAt = now
		if existingSession.Source.DaVinci != nil {
			existingSession.Source.DaVinci.LastSyncedAt = now.Unix()
			existingSession.Source.DaVinci.IsConnected = true
		}
		a.activeTimelineID = existingSession.ID

		// Keep legacy pointer updated
		a.currentProjectMu.Lock()
		a.currentProject = pd
		a.otioReadyChan = otioChan
		a.currentProjectMu.Unlock()

		log.Printf("Session: Updated existing DaVinci timeline session '%s' (ID: %s)", timelineName, existingSession.ID)
		return existingSession
	}

	// Create new session
	sessionID := "tl_" + uuid.NewString()[:8]
	session := &TimelineSession{
		ID:   sessionID,
		Name: timelineName,
		Source: TimelineSource{
			Kind: TimelineKindDaVinci,
			DaVinci: &DaVinciSyncInfo{
				ProjectName:  projectName,
				TimelineName: timelineName,
				LastSyncedAt: now.Unix(),
				IsConnected:  true,
			},
		},
		Data:          pd,
		OTIOReadyChan: otioChan,
		IsDirty:       false,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	a.timelineSessions[sessionID] = session
	a.timelineOrder = append(a.timelineOrder, sessionID)
	a.activeTimelineID = sessionID

	// Keep legacy pointer updated
	a.currentProjectMu.Lock()
	a.currentProject = pd
	a.otioReadyChan = otioChan
	a.currentProjectMu.Unlock()

	log.Printf("Session: Created new DaVinci timeline session '%s' (ID: %s)", timelineName, sessionID)
	return session
}

// GetActiveTimelineSession returns the currently active TimelineSession.
func (a *App) GetActiveTimelineSession() *TimelineSession {
	a.sessionMu.RLock()
	defer a.sessionMu.RUnlock()

	if a.activeTimelineID != "" {
		if s, ok := a.timelineSessions[a.activeTimelineID]; ok {
			return s
		}
	}
	return nil
}

// GetTimelineSessions returns summaries for all currently open timeline tabs in order.
func (a *App) GetTimelineSessions() []TimelineSessionSummary {
	a.sessionMu.RLock()
	defer a.sessionMu.RUnlock()

	summaries := make([]TimelineSessionSummary, 0, len(a.timelineOrder))
	for _, id := range a.timelineOrder {
		if s, ok := a.timelineSessions[id]; ok {
			summaries = append(summaries, s.Summary(s.ID == a.activeTimelineID))
		}
	}
	return summaries
}

// SetActiveTimelineSession switches the active timeline tab by ID instantly without contacting DaVinci.
func (a *App) SetActiveTimelineSession(sessionID string) (*TimelineSession, error) {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	session, exists := a.timelineSessions[sessionID]
	if !exists {
		return nil, fmt.Errorf("timeline session '%s' not found", sessionID)
	}

	a.activeTimelineID = sessionID

	// Keep legacy pointers in sync
	a.currentProjectMu.Lock()
	a.currentProject = session.Data
	a.otioReadyChan = session.OTIOReadyChan
	a.currentProjectMu.Unlock()

	log.Printf("Session: Switched active timeline to '%s' (ID: %s)", session.Name, sessionID)
	a.emitEvent("activeTimelineChanged", session.Summary(true))
	return session, nil
}

// CreateStandaloneTimeline creates a new, empty standalone timeline session ready for media.
func (a *App) CreateStandaloneTimeline(name string, fps float64) *TimelineSession {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	if a.timelineSessions == nil {
		a.timelineSessions = make(map[string]*TimelineSession)
	}

	if name == "" {
		name = fmt.Sprintf("Standalone %d", len(a.timelineSessions)+1)
	}
	if fps <= 0 {
		fps = 30.0
	}

	now := time.Now()
	sessionID := "tl_" + uuid.NewString()[:8]

	pd := &ProjectDataPayload{
		ProjectName: "Standalone Project",
		Timeline: Timeline{
			Name:            name,
			FPS:             fps,
			ProjectFPS:      fps,
			StartTimecode:   "00:00:00:00",
			CurrTimecode:    "00:00:00:00",
			VideoTrackItems: []TimelineItem{},
			AudioTrackItems: []TimelineItem{},
		},
		Files: make(map[string]FileData),
	}

	session := &TimelineSession{
		ID:   sessionID,
		Name: name,
		Source: TimelineSource{
			Kind: TimelineKindStandalone,
		},
		Data:          pd,
		OTIOReadyChan: nil,
		IsDirty:       false,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	a.timelineSessions[sessionID] = session
	a.timelineOrder = append(a.timelineOrder, sessionID)
	a.activeTimelineID = sessionID

	a.currentProjectMu.Lock()
	a.currentProject = pd
	a.otioReadyChan = nil
	a.currentProjectMu.Unlock()

	log.Printf("Session: Created new standalone timeline session '%s' (ID: %s)", name, sessionID)
	a.emitEvent("timelineSessionsUpdated", a.getTimelineSummariesLocked())
	a.emitEvent("activeTimelineChanged", session.Summary(true))
	return session
}

// ConvertTimelineToStandalone clones a DaVinci or standalone timeline into an independent standalone timeline.
func (a *App) ConvertTimelineToStandalone(sourceID string, newName string) (*TimelineSession, error) {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	sourceSession, exists := a.timelineSessions[sourceID]
	if !exists {
		return nil, fmt.Errorf("source timeline session '%s' not found", sourceID)
	}

	clonedData, err := deepCopyProjectData(sourceSession.Data)
	if err != nil {
		return nil, fmt.Errorf("failed to clone timeline data: %w", err)
	}

	if newName == "" {
		newName = fmt.Sprintf("%s (Standalone)", sourceSession.Name)
	}
	if clonedData != nil {
		clonedData.Timeline.Name = newName
		clonedData.ProjectName = "Standalone Project"
	}

	now := time.Now()
	newID := "tl_" + uuid.NewString()[:8]

	standaloneSession := &TimelineSession{
		ID:   newID,
		Name: newName,
		Source: TimelineSource{
			Kind: TimelineKindStandalone,
		},
		Data:          clonedData,
		OTIOReadyChan: nil,
		IsDirty:       true, // Newly cloned copy with un-tethered changes
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	a.timelineSessions[newID] = standaloneSession
	a.timelineOrder = append(a.timelineOrder, newID)
	a.activeTimelineID = newID

	a.currentProjectMu.Lock()
	a.currentProject = clonedData
	a.otioReadyChan = nil
	a.currentProjectMu.Unlock()

	log.Printf("Session: Converted '%s' to standalone timeline '%s' (ID: %s)", sourceSession.Name, newName, newID)
	a.emitEvent("timelineSessionsUpdated", a.getTimelineSummariesLocked())
	a.emitEvent("activeTimelineChanged", standaloneSession.Summary(true))
	return standaloneSession, nil
}

// CloseTimelineSession closes an open timeline session.
func (a *App) CloseTimelineSession(sessionID string) error {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	if _, exists := a.timelineSessions[sessionID]; !exists {
		return fmt.Errorf("timeline session '%s' not found", sessionID)
	}

	delete(a.timelineSessions, sessionID)

	// Remove from order slice
	newOrder := make([]string, 0, len(a.timelineOrder)-1)
	for _, id := range a.timelineOrder {
		if id != sessionID {
			newOrder = append(newOrder, id)
		}
	}
	a.timelineOrder = newOrder

	// If closed session was active, select next available
	if a.activeTimelineID == sessionID {
		if len(a.timelineOrder) > 0 {
			a.activeTimelineID = a.timelineOrder[len(a.timelineOrder)-1]
			nextSession := a.timelineSessions[a.activeTimelineID]
			a.currentProjectMu.Lock()
			a.currentProject = nextSession.Data
			a.otioReadyChan = nextSession.OTIOReadyChan
			a.currentProjectMu.Unlock()
			a.emitEvent("activeTimelineChanged", nextSession.Summary(true))
		} else {
			a.activeTimelineID = ""
			a.currentProjectMu.Lock()
			a.currentProject = nil
			a.otioReadyChan = nil
			a.currentProjectMu.Unlock()
			a.emitEvent("activeTimelineChanged", nil)
		}
	}

	log.Printf("Session: Closed timeline session '%s'", sessionID)
	a.emitEvent("timelineSessionsUpdated", a.getTimelineSummariesLocked())
	return nil
}

func (a *App) getTimelineSummariesLocked() []TimelineSessionSummary {
	summaries := make([]TimelineSessionSummary, 0, len(a.timelineOrder))
	for _, id := range a.timelineOrder {
		if s, ok := a.timelineSessions[id]; ok {
			summaries = append(summaries, s.Summary(s.ID == a.activeTimelineID))
		}
	}
	return summaries
}
