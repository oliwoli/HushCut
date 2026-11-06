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
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/oliwoli/hushcut/internal/luahelperlogic"
    "github.com/wailsapp/wails/v3/pkg/application"
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
	FilePath        string // It's advisable to use an absolute/canonical path here if effectiveAudioFolderPath can change
	SamplesPerPixel int
	PeakType        string // "logarithmic" or "linear"
	MinDb           float64
	MaxDb           float64 // maxDb is used by ProcessWavToLogarithmicPeaks
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
	inputFile := flag.String("input-file", "", "JSON file with array of strings to batch UUID")
	flag.Parse()

	var pipeContent string
	if *inputFile != "" {
		data, err := os.ReadFile(*inputFile)
		if err != nil {
			panic(err)
		}
		pipeContent = string(data)
	} else if runtime.GOOS != "windows" {
		// fallback to stdin
		stat, _ := os.Stdin.Stat()
		if (stat.Mode() & os.ModeCharDevice) == 0 {
			data, err := io.ReadAll(os.Stdin)
			if err == nil {
				pipeContent = string(data)
			}
		}
	}

	if *luaMode {
		luahelperlogic.Start(*port, *findPort, *uuidCount, *uuidStr, pipeContent)
		return // Exit after running in helper mode
	}

	// Create an instance of the app structure
	appInstance := NewApp()
	appInstance.licenseVerifyKey = PublicKeyPEM
	if *pythonPort != 0 {
		appInstance.pythonCommandPort = *pythonPort
	}
	appInstance.testApi = testApi

	if token := os.Getenv("HUSHCUT_AUTH_TOKEN"); token != "" {
		log.Printf("Received HushCut Token from environment variable.")
		appInstance.authToken = strings.TrimSpace(token)
	} else {
		log.Printf("No HUSHCUT_AUTH_TOKEN provided in environment.")
	}

	// Check for WAILS_PYTHON_PORT environment variable (used when launched by Python in dev mode)
	if pythonPortStr := os.Getenv("WAILS_PYTHON_PORT"); pythonPortStr != "" {
		if p, err := strconv.Atoi(pythonPortStr); err == nil {
			appInstance.pythonCommandPort = p
			log.Printf("Go App: Received Python port from environment variable: %d", appInstance.pythonCommandPort)
		} else {
			log.Printf("Go App: Could not parse WAILS_PYTHON_PORT environment variable: %v", err)
		}
	}

	// Create application with options
	app := application.New(application.Options{
		Name:        "HushCut",
		Description: "HushCut",
		Icon:        icon,
		Services: []application.Service{
			application.NewService(appInstance),
		},
		Server: application.ServerOptions{
			Host: "127.0.0.1",
			Port: 8080,
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
					if req.URL.Path == "/wails/custom.js" || strings.HasSuffix(req.URL.Path, "custom.js") {
						rw.Header().Set("Content-Type", "application/javascript")
						rw.WriteHeader(http.StatusOK)
						return
					}
					next.ServeHTTP(rw, req)
				})
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		Linux: application.LinuxOptions{
			ProgramName: "HushCut",
		},
	})

	isDev := app.Env.Info().Debug

	windowOptions := application.WebviewWindowOptions{
		Title:            "HushCut",
		Width:            1024,
		Height:           801,
		MinWidth:         500,
		MinHeight:        550,
		AlwaysOnTop:      true,
		Frameless:        true,
		BackgroundColour: application.NewRGBA(40, 40, 46, 255),
		URL:              "/",
		DevToolsEnabled:  isDev,
		Mac: application.MacWindow{
			TitleBar:   application.MacTitleBarHidden,
			Appearance: application.NSAppearanceNameDarkAqua,
		},
		Linux: application.LinuxWindow{
			Icon:             icon,
			WebviewGpuPolicy: application.WebviewGpuPolicyNever,
		},
	}

	if isDev {
		windowOptions.KeyBindings = map[string]func(window application.Window){
			"CmdOrCtrl+Alt+I": func(window application.Window) {
				window.OpenDevTools()
				openNativeDevTools(window.NativeWindow())
			},
			"F12": func(window application.Window) {
				window.OpenDevTools()
				openNativeDevTools(window.NativeWindow())
			},
		}
	}

	win := app.Window.NewWithOptions(windowOptions)

	appInstance.SetApplication(app, win)
	if isDev {
		enableNativeDevTools(win.NativeWindow())
	}

	err := app.Run()
	if err != nil {
		log.Println("Error:", err.Error())
	}
}
