package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
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
	LoudnessThreshold         float64 `json:"loudnessThreshold"`
	MinSilenceDurationSeconds float64 `json:"minSilenceDurationSeconds"`
	PaddingLeftSeconds        float64 `json:"paddingLeftSeconds"`
	PaddingRightSeconds       float64 `json:"paddingRightSeconds"`
	MinContentDuration        float64 `json:"minContentDuration"`
	ClipStartSeconds          float64 `json:"clipStartSeconds"`
	ClipEndSeconds            float64 `json:"clipEndSeconds"`
}

type WaveformCacheKey struct {
	FilePath         string // It's advisable to use an absolute/canonical path here if effectiveAudioFolderPath can change
	SamplesPerPixel  int
	PeakType         string // "logarithmic" or "linear"
	MinDb            float64
	MaxDb            float64 // maxDb is used by ProcessWavToLogarithmicPeaks
	ClipStartSeconds float64
	ClipEndSeconds   float64
}

type FileLoader struct {
	http.Handler
}

func NewFileLoader() *FileLoader {
	return &FileLoader{}
}

func (h *FileLoader) ServeHTTP(res http.ResponseWriter, req *http.Request) {
	var err error
	requestedFilename := strings.TrimPrefix(req.URL.Path, "/")
	println("Requesting file:", requestedFilename)
	fileData, err := os.ReadFile(requestedFilename)
	if err != nil {
		res.WriteHeader(http.StatusBadRequest)
		res.Write([]byte(fmt.Sprintf("Could not load file %s", requestedFilename)))
	}

	res.Write(fileData)
}

//go:embed build/appicon.png
var icon []byte

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Check for WAILS_PYTHON_PORT environment variable (used when launched by Python in dev mode)
	if pythonPortStr := os.Getenv("WAILS_PYTHON_PORT"); pythonPortStr != "" {
		if p, err := strconv.Atoi(pythonPortStr); err == nil {
			app.pythonCommandPort = p
			log.Printf("Go App: Received Python port from environment variable: %d", app.pythonCommandPort)
		} else {
			log.Printf("Go App: Could not parse WAILS_PYTHON_PORT environment variable: %v", err)
		}
	}

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "HushCut",
		Width:     1024,
		Height:    801,
		MinWidth:  500,
		MinHeight: 550,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: NewFileLoader(),
		},
		BackgroundColour: &options.RGBA{R: 40, G: 40, B: 46, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
		LogLevel:    logger.INFO,
		AlwaysOnTop: true,
		Frameless:   true,
		Linux: &linux.Options{
			Icon:                icon,
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyNever,
			ProgramName:         "HushCut",
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
