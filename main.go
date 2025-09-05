package main

import (
	"embed"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/oliwoli/hushcut/internal/luahelperlogic"
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
	return &FileLoader{
		// CORRECT: Initialize the embedded handler with the default
		// file server, telling it to serve your embedded assets.
		Handler: http.FileServer(http.FS(assets)),
	}
}

//go:embed build/appicon.png
var icon []byte

//go:embed secrets/public_key.pem
var PublicKeyPEM []byte

func writeCrashLog(message string) {
	now := time.Now().Format("2006-01-02_15-04-05")
	filename := fmt.Sprintf("crash_%s.txt", now)

	base := filepath.Join(os.Getenv("LOCALAPPDATA"), "HushCut")
	_ = os.MkdirAll(base, 0755)

	f, err := os.Create(filepath.Join(base, filename))
	if err != nil {
		return
	}
	defer f.Close()

	f.WriteString(message + "\n")
}

func main() {
	defer func() {
		if r := recover(); r != nil {
			writeCrashLog(fmt.Sprintf("panic: %v", r))
			panic(r)
		}
	}()

	testApi := os.Getenv("TEST_API") == "1"

	luaMode := flag.Bool("lua-helper", false, "start headless in lua-helper mode")
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")

	uuidCount := flag.Int("uuid", 0, "generate N random UUIDs")
	uuidStr := flag.String("uuid-from-str", "", "comma-separated list of strings to generate deterministic UUIDs")

	pythonPort := flag.Int("python-port", 0, "port python should listen on")

	flag.Parse()

	var pipeContent string
	// Check if there’s data coming in via stdin
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		// stdin is not from a terminal, so read it
		data, err := io.ReadAll(os.Stdin)
		if err == nil {
			pipeContent = string(data)
		}
	}

	if *luaMode {
		luahelperlogic.Start(*port, *findPort, *uuidCount, *uuidStr, pipeContent)
		return // Exit after running in helper mode
	}

	// Create an instance of the app structure
	app := NewApp()
	app.licenseVerifyKey = PublicKeyPEM
	if *pythonPort != 0 {
		app.pythonCommandPort = *pythonPort
	}
	app.testApi = testApi

	if token := os.Getenv("HUSHCUT_AUTH_TOKEN"); token != "" {
		log.Printf("Received HushCut Token from environment variable.")
		app.authToken = strings.TrimSpace(token)
	} else {
		log.Printf("No HUSHCUT_AUTH_TOKEN provided in environment.")
	}

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
		log.Println("Error:", err.Error())
	}
}
