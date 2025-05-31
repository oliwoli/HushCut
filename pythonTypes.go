package main

// ClipData corresponds to the Python ClipData TypedDict.
type ClipData struct {
	SourceStartFrame float64 `json:"source_start_frame"`
	SourceEndFrame   float64 `json:"source_end_frame"` // Inclusive end point/time
	StartFrame       float64 `json:"start_frame"`
	EndFrame         float64 `json:"end_frame"`
}

// SilenceInterval corresponds to the Python SilenceInterval TypedDict.
type SilenceInterval struct {
	Start float64 `json:"start"` // Inclusive source frame/time
	End   float64 `json:"end"`   // Exclusive source frame/time
}

// EditInstruction corresponds to the Python EditInstruction TypedDict.
type EditInstruction struct {
	SourceStartFrame float64 `json:"source_start_frame"` // Precise source start point/time (inclusive)
	SourceEndFrame   float64 `json:"source_end_frame"`   // Precise source end point/time (inclusive)
	StartFrame       float64 `json:"start_frame"`        // Calculated timeline start frame (inclusive)
	EndFrame         float64 `json:"end_frame"`          // Calculated timeline end frame (inclusive)
	Enabled          bool    `json:"enabled"`
}

// FileProperties corresponds to the Python FileProperties TypedDict.
type FileProperties struct {
	FPS float64 `json:"FPS"`
}

// TimelineItem corresponds to the Python TimelineItem TypedDict.
type TimelineItem struct {
	BmdItem           interface{}       `json:"bmd_item"` // Corresponds to Python's Any type
	Name              string            `json:"name"`
	ID                string            `json:"id"`
	TrackType         string            `json:"track_type"` // Expected: "video", "audio", "subtitle"
	TrackIndex        int               `json:"track_index"`
	SourceFilePath    string            `json:"source_file_path"`
	ProcessedFileName string            `json:"processed_file_name"`
	StartFrame        float64           `json:"start_frame"`
	EndFrame          float64           `json:"end_frame"`
	SourceStartFrame  float64           `json:"source_start_frame"`
	SourceEndFrame    float64           `json:"source_end_frame"`
	Duration          float64           `json:"duration"`
	EditInstructions  []EditInstruction `json:"edit_instructions"`
}

// FileSource corresponds to the Python FileSource TypedDict.
type FileSource struct {
	BmdMediaPoolItem interface{} `json:"bmd_media_pool_item"` // Corresponds to Python's Any type
	FilePath         string      `json:"file_path"`
	UUID             string      `json:"uuid"`
}

// FileData corresponds to the Python FileData TypedDict.
type FileData struct {
	Properties        FileProperties     `json:"properties"`
	SilenceDetections []*SilenceInterval `json:"silenceDetections,omitempty"` // Slice of pointers to handle optionality/null
	TimelineItems     []TimelineItem     `json:"timelineItems"`
	FileSource        FileSource         `json:"fileSource"`
}

// Timeline corresponds to the Python Timeline TypedDict.
type Timeline struct {
	Name            string         `json:"name"`
	FPS             float64        `json:"fps"`
	VideoTrackItems []TimelineItem `json:"video_track_items"`
	AudioTrackItems []TimelineItem `json:"audio_track_items"`
}

// ProjectDataPayload is the Go equivalent of the Python ProjectData TypedDict.
// This structure is adjusted to match the provided Python ProjectData.
type ProjectDataPayload struct {
	ProjectName string              `json:"project_name"`
	Timeline    Timeline            `json:"timeline"`
	Files       map[string]FileData `json:"files"`
}

// Track corresponds to the Python Track TypedDict.
// Note: This struct and ItemsByTracks are not part of ProjectData,
// but are included for completeness from your Python definitions.
type Track struct {
	Name  string        `json:"name"`
	Type  string        `json:"type"` // Expected: "video", "audio"
	Index int           `json:"index"`
	Items []interface{} `json:"items"` // Corresponds to Python's List[Any]
}

// ItemsByTracks corresponds to the Python ItemsByTracks TypedDict.
type ItemsByTracks struct {
	VideoTrack []Track `json:"videotrack"`
	AudioTrack []Track `json:"audiotrack"`
}

// EditFrames corresponds to the Python EditFrames TypedDict.
type EditFrames struct {
	StartFrame       float64 `json:"start_frame"`
	EndFrame         float64 `json:"end_frame"`
	SourceStartFrame float64 `json:"source_start_frame"`
	SourceEndFrame   float64 `json:"source_end_frame"`
	Duration         float64 `json:"duration"`
}

// TimelineProperties corresponds to the Python TimelineProperties TypedDict.
type TimelineProperties struct {
	Name       string         `json:"name"`
	FPS        float64        `json:"FPS"`
	ItemUsages []TimelineItem `json:"item_usages"`
}
