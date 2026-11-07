package main

import (
	"testing"
)

func TestTimelineSession_UpsertDaVinciSession(t *testing.T) {
	app := NewApp()

	pd1 := &ProjectDataPayload{
		ProjectName: "Project Alpha",
		Timeline: Timeline{
			Name: "Timeline 1",
			FPS:  60.0,
			AudioTrackItems: []TimelineItem{
				{ID: "a1", Name: "audio1.wav", StartFrame: 0, EndFrame: 1000},
			},
		},
	}

	otioChan1 := make(chan struct{})
	s1 := app.UpsertDaVinciSession(pd1, otioChan1)

	if s1 == nil {
		t.Fatal("Expected s1 to not be nil")
	}
	if s1.Source.Kind != TimelineKindDaVinci {
		t.Errorf("Expected s1 kind to be %s, got %s", TimelineKindDaVinci, s1.Source.Kind)
	}
	if s1.Source.DaVinci.ProjectName != "Project Alpha" || s1.Source.DaVinci.TimelineName != "Timeline 1" {
		t.Errorf("Source DaVinci info mismatch: %+v", s1.Source.DaVinci)
	}
	if app.activeTimelineID != s1.ID {
		t.Errorf("Expected active timeline ID %s, got %s", s1.ID, app.activeTimelineID)
	}
	if app.currentProject != pd1 {
		t.Errorf("Expected app.currentProject to match pd1")
	}

	// 2. Upsert same timeline again (e.g. re-sync): must update in-place without duplicating
	pd1Updated := &ProjectDataPayload{
		ProjectName: "Project Alpha",
		Timeline: Timeline{
			Name: "Timeline 1",
			FPS:  60.0,
			AudioTrackItems: []TimelineItem{
				{ID: "a1", Name: "audio1.wav", StartFrame: 0, EndFrame: 2000},
			},
		},
	}
	s1Updated := app.UpsertDaVinciSession(pd1Updated, otioChan1)
	if s1Updated.ID != s1.ID {
		t.Errorf("Expected updated session ID %s, got new ID %s", s1.ID, s1Updated.ID)
	}
	if len(app.GetTimelineSessions()) != 1 {
		t.Errorf("Expected 1 session in workspace, got %d", len(app.GetTimelineSessions()))
	}
	if s1Updated.Data.Timeline.AudioTrackItems[0].EndFrame != 2000 {
		t.Errorf("Expected updated EndFrame 2000, got %.2f", s1Updated.Data.Timeline.AudioTrackItems[0].EndFrame)
	}

	// 3. Upsert a second timeline: must create a new session and keep s1 cached in memory
	pd2 := &ProjectDataPayload{
		ProjectName: "Project Alpha",
		Timeline: Timeline{
			Name: "Timeline 2",
			FPS:  24.0,
			AudioTrackItems: []TimelineItem{
				{ID: "a2", Name: "audio2.wav", StartFrame: 0, EndFrame: 500},
			},
		},
	}
	otioChan2 := make(chan struct{})
	s2 := app.UpsertDaVinciSession(pd2, otioChan2)

	if s2.ID == s1.ID {
		t.Errorf("Expected s2 to have distinct ID, got same %s", s2.ID)
	}
	if len(app.GetTimelineSessions()) != 2 {
		t.Errorf("Expected 2 sessions in workspace, got %d", len(app.GetTimelineSessions()))
	}
	if app.activeTimelineID != s2.ID {
		t.Errorf("Expected active timeline to be s2 (%s), got %s", s2.ID, app.activeTimelineID)
	}

	// Verify s1 is still in memory and intact
	activeS := app.GetActiveTimelineSession()
	if activeS.ID != s2.ID {
		t.Errorf("Expected active session s2, got %s", activeS.ID)
	}
}

func TestTimelineSession_SetActiveTimelineSession_InstantSwitching(t *testing.T) {
	app := NewApp()

	pd1 := &ProjectDataPayload{
		ProjectName: "Project Alpha",
		Timeline: Timeline{
			Name: "Timeline 1",
			FPS:  60.0,
			AudioTrackItems: []TimelineItem{
				{ID: "a1", Name: "audio1.wav", StartFrame: 0, EndFrame: 1000},
			},
		},
	}
	pd2 := &ProjectDataPayload{
		ProjectName: "Project Alpha",
		Timeline: Timeline{
			Name: "Timeline 2",
			FPS:  24.0,
			AudioTrackItems: []TimelineItem{
				{ID: "a2", Name: "audio2.wav", StartFrame: 0, EndFrame: 500},
			},
		},
	}

	s1 := app.UpsertDaVinciSession(pd1, nil)
	s2 := app.UpsertDaVinciSession(pd2, nil)

	if app.activeTimelineID != s2.ID {
		t.Fatalf("Expected active timeline s2")
	}

	// Switch back to s1: must succeed instantly and update currentProject
	switched, err := app.SetActiveTimelineSession(s1.ID)
	if err != nil {
		t.Fatalf("SetActiveTimelineSession failed: %v", err)
	}
	if switched.ID != s1.ID {
		t.Errorf("Expected switched session %s, got %s", s1.ID, switched.ID)
	}
	if app.activeTimelineID != s1.ID {
		t.Errorf("Expected activeTimelineID %s, got %s", s1.ID, app.activeTimelineID)
	}
	if app.currentProject != pd1 {
		t.Errorf("Expected currentProject to be pd1")
	}

	// Switching to invalid ID must return error
	_, err = app.SetActiveTimelineSession("nonexistent_id")
	if err == nil {
		t.Errorf("Expected error when switching to invalid ID, got nil")
	}
}

func TestTimelineSession_CreateStandaloneTimeline(t *testing.T) {
	app := NewApp()

	session := app.CreateStandaloneTimeline("My Podcast Edit", 24.0)
	if session == nil {
		t.Fatal("Expected created session to not be nil")
	}
	if session.Source.Kind != TimelineKindStandalone {
		t.Errorf("Expected source kind %s, got %s", TimelineKindStandalone, session.Source.Kind)
	}
	if session.Source.DaVinci != nil {
		t.Errorf("Expected Source.DaVinci to be nil for standalone timeline")
	}
	if session.Name != "My Podcast Edit" {
		t.Errorf("Expected name 'My Podcast Edit', got '%s'", session.Name)
	}
	if session.Data.Timeline.FPS != 24.0 {
		t.Errorf("Expected FPS 24.0, got %.2f", session.Data.Timeline.FPS)
	}
	if app.activeTimelineID != session.ID {
		t.Errorf("Expected activeTimelineID %s, got %s", session.ID, app.activeTimelineID)
	}
}

func TestTimelineSession_ConvertTimelineToStandalone(t *testing.T) {
	app := NewApp()

	pd := &ProjectDataPayload{
		ProjectName: "DaVinci Project",
		Timeline: Timeline{
			Name: "DaVinci Timeline 1",
			FPS:  60.0,
			AudioTrackItems: []TimelineItem{
				{ID: "clip_1", Name: "camera.mov", StartFrame: 100, EndFrame: 500},
			},
		},
	}
	daVinciSession := app.UpsertDaVinciSession(pd, nil)

	// Convert / duplicate to standalone
	standaloneSession, err := app.ConvertTimelineToStandalone(daVinciSession.ID, "Detached Cut")
	if err != nil {
		t.Fatalf("ConvertTimelineToStandalone failed: %v", err)
	}

	if standaloneSession.ID == daVinciSession.ID {
		t.Errorf("Expected new unique ID for standalone session, got same ID")
	}
	if standaloneSession.Source.Kind != TimelineKindStandalone {
		t.Errorf("Expected kind %s, got %s", TimelineKindStandalone, standaloneSession.Source.Kind)
	}
	if standaloneSession.Source.DaVinci != nil {
		t.Errorf("Expected DaVinci info to be nil on standalone session")
	}
	if standaloneSession.Name != "Detached Cut" {
		t.Errorf("Expected name 'Detached Cut', got '%s'", standaloneSession.Name)
	}
	// Verify deep copy: mutating standalone data does not affect original DaVinci data
	standaloneSession.Data.Timeline.AudioTrackItems[0].EndFrame = 999
	if daVinciSession.Data.Timeline.AudioTrackItems[0].EndFrame == 999 {
		t.Errorf("Expected deep copy: mutating standalone session modified original DaVinci session!")
	}
	if len(app.GetTimelineSessions()) != 2 {
		t.Errorf("Expected 2 sessions in workspace, got %d", len(app.GetTimelineSessions()))
	}
}

func TestTimelineSession_CloseTimelineSession(t *testing.T) {
	app := NewApp()

	s1 := app.CreateStandaloneTimeline("Timeline 1", 30.0)
	s2 := app.CreateStandaloneTimeline("Timeline 2", 30.0)

	if app.activeTimelineID != s2.ID {
		t.Fatalf("Expected active timeline to be s2")
	}

	// Close active s2: s1 should become active
	err := app.CloseTimelineSession(s2.ID)
	if err != nil {
		t.Fatalf("CloseTimelineSession failed: %v", err)
	}

	if app.activeTimelineID != s1.ID {
		t.Errorf("Expected active timeline to fall back to s1 (%s), got %s", s1.ID, app.activeTimelineID)
	}
	if len(app.GetTimelineSessions()) != 1 {
		t.Errorf("Expected 1 remaining session, got %d", len(app.GetTimelineSessions()))
	}

	// Close remaining s1: active timeline becomes empty
	err = app.CloseTimelineSession(s1.ID)
	if err != nil {
		t.Fatalf("CloseTimelineSession failed on last session: %v", err)
	}
	if app.activeTimelineID != "" {
		t.Errorf("Expected empty activeTimelineID, got %s", app.activeTimelineID)
	}
	if app.currentProject != nil {
		t.Errorf("Expected app.currentProject to be nil when all sessions closed")
	}
}
