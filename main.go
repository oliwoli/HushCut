package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// SilencePeriod (from previous step)
type SilencePeriod struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// CacheKey defines the unique identifier for a silence detection request.
type CacheKey struct {
	FilePath                  string  `json:"filePath"` // Using struct tags for potential future use, not strictly necessary for map key
	LoudnessThreshold         string  `json:"loudnessThreshold"`
	MinSilenceDurationSeconds string  `json:"minSilenceDurationSeconds"`
	PaddingLeftSeconds        float64 `json:"paddingLeftSeconds"`
	PaddingRightSeconds       float64 `json:"paddingRightSeconds"`
}

func main() {
	// Serve the frontend assets

	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "resocut",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 40, G: 40, B: 46, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
		AlwaysOnTop: true,
		Frameless:   true,
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
