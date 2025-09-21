package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type FfmpegStatus int

// ENUM
const (
	StatusUnknown FfmpegStatus = iota // 0
	StatusReady                       // 1
	StatusMissing                     // 2
)

type App struct {
	ctx     context.Context
	isDev   bool
	testApi bool

	appVersion    string
	ffmpegVersion string
	updateInfo    *UpdateResponseV1

	licenseMutex     sync.Mutex
	licenseVerifyKey []byte
	licenseValid     bool
	licenseOkChan    chan bool
	machineID        string

	silenceCache      map[CacheKey][]SilencePeriod
	waveformCache     map[WaveformCacheKey]*PrecomputedWaveformData
	cacheMutex        sync.RWMutex
	pythonCmd         *exec.Cmd
	pythonReadyChan   chan bool
	pythonReady       bool
	pythonCommandPort int
	resourcesPath     string
	userResourcesPath string
	tmpPath           string
	pendingMu         sync.Mutex
	pendingTasks      map[string]chan PythonCommandResponse
	ffmpegBinaryPath  string
	ffmpegStatus      FfmpegStatus
	ffmpegSemaphore   chan struct{}
	waveformSemaphore chan struct{}
	progressTracker   sync.Map
	fileUsage         map[string]time.Time
	mu                sync.Mutex

	// -- HTTP -- //
	httpClient *http.Client
	authToken  string

	// --- FFmpeg STATE ---
	ffmpegMutex     sync.RWMutex
	ffmpegReadyChan chan struct{}
	ffmpegOnce      sync.Once // Ensures the ready channel is closed only once
	// ----- //

}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		licenseOkChan:     make(chan bool, 1),
		silenceCache:      make(map[CacheKey][]SilencePeriod),
		waveformCache:     make(map[WaveformCacheKey]*PrecomputedWaveformData),
		pythonReadyChan:   make(chan bool, 1),
		pythonReady:       false,
		tmpPath:           "", // Will be initialized in startup
		pendingTasks:      make(map[string]chan PythonCommandResponse),
		ffmpegSemaphore:   make(chan struct{}, 8),
		waveformSemaphore: make(chan struct{}, 3),
		progressTracker:   sync.Map{},
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		ffmpegStatus:    StatusUnknown,
		ffmpegReadyChan: make(chan struct{}),

		appVersion:    AppVersion,
		ffmpegVersion: FfmpegVersion,
		fileUsage:     make(map[string]time.Time),
	}
}

func (a *App) SetWindowAlwaysOnTop(alwaysOnTop bool) {
	runtime.WindowSetAlwaysOnTop(a.ctx, alwaysOnTop)
}

func (a *App) OpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}

type ProgressTracker struct {
	mu         sync.RWMutex // Protects access to the percentage
	Percentage float64
	Done       chan error
	TaskType   string
}

func (a *App) ResolveBinaryPath(binaryName string) (string, error) {
	platform := runtime.Environment(a.ctx).Platform

	goExecutablePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("could not get executable path: %w", err)
	}
	goExecutableDir := filepath.Dir(goExecutablePath)

	// Adjust binary name for Windows
	if platform == "windows" {
		binaryName += ".exe"
	}

	// Attempt to resolve relative to the Go executable
	var candidatePath string
	switch platform {
	case "darwin":
		// Look in ../Resources/ relative to the executable
		candidatePath = filepath.Join(goExecutableDir, "..", "Resources", binaryName)

	case "windows", "linux":
		// Look in the same directory as the executable
		candidatePath = filepath.Join(goExecutableDir, binaryName)
	}

	if candidatePath != "" {
		if _, statErr := os.Stat(candidatePath); statErr == nil {
			return filepath.Abs(candidatePath)
		}
	}

	// Fallbacks if not found relative to executable
	switch platform {
	case "darwin":
		// Fallback for development mode (wails dev)
		candidatePath = filepath.Join(goExecutableDir, "..", "..", "build", "bin", binaryName)
		if _, statErr := os.Stat(candidatePath); statErr == nil {
			return filepath.Abs(candidatePath)
		}
		// Fallback: relative to working directory (development mode?)
		return filepath.Abs(filepath.Join("..", "Resources", binaryName))

	case "windows", "linux":
		// Fallback for development mode (wails dev)
		candidatePath = filepath.Join(goExecutableDir, "..", "build", "bin", binaryName)
		if _, statErr := os.Stat(candidatePath); statErr == nil {
			return filepath.Abs(candidatePath)
		}
		// Fallback: look in current working directory
		return filepath.Abs(binaryName)

	default:
		return "", fmt.Errorf("unsupported platform: %s", platform)
	}
}

// launch python backend and wait for POST /ready on http server endpoint
func (a *App) LaunchPythonBackend(port int, pythonCommandPort int) error {

	pythonBinaryPath := filepath.Join(a.resourcesPath, "python_backend")

	platform := runtime.Environment(a.ctx).Platform
	if platform == "windows" {
		pythonBinaryPath = filepath.Join(a.resourcesPath, "python_backend.exe")
	}

	cmdArgs := []string{
		"--go-port", fmt.Sprintf("%d", port),
		"--listen-on-port", fmt.Sprintf("%d", pythonCommandPort),
	}

	cmd := ExecCommand(pythonBinaryPath, cmdArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}

	go func() {
		defer stdin.Close()
		io.WriteString(stdin, a.authToken)
	}()

	a.pythonCmd = cmd

	if err := cmd.Start(); err != nil {
		return err
	}
	log.Printf("Go app: Python backend process started (PID: %d, Path: '%s'). Waiting for its HTTP ready signal.\n", cmd.Process.Pid, pythonBinaryPath)
	return nil
}

func (a *App) GetGoServerPort() int {
	if !isServerInitialized {
		log.Println("Wails App: GetAudioServerPort called, but server is not (yet) initialized or failed to start. Returning 0.")
		return 0
	}
	return actualPort
}

func getMacCacheTmpDir() string {
	homeDir, err := os.UserHomeDir()
	if err != nil || homeDir == "" {
		return filepath.Join(os.TempDir(), "HushCut")
	}

	// ~/Library/Caches/HushCut/tmp
	return filepath.Join(homeDir, "Library", "Caches", "HushCut", "tmp")
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	envInfo := runtime.Environment(ctx)
	if envInfo.BuildType == "production" {
		log.Println("|> HushCut v" + a.GetAppVersion() + " - Production Build")
		a.isDev = false
	} else {
		log.Println("|> HushCut v" + a.GetAppVersion() + " - Development Build")
		a.isDev = true
	}

	goExecutablePath, err_exec := os.Executable()
	if err_exec != nil {
		log.Fatalf("Could not get executable path: %v", err_exec)
	}
	goExecutableDir := filepath.Dir(goExecutablePath)

	platform := runtime.Environment(a.ctx).Platform
	switch platform {
	case "darwin":
		configDir, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("failed to get user config dir: %v", err)
		}

		// Store resources in ~/Library/Application Support/HushCut
		a.userResourcesPath = filepath.Join(configDir, "HushCut")
		a.resourcesPath = filepath.Join(filepath.Dir(goExecutableDir), "Resources")

		// Temp folder in system tmp
		a.tmpPath = getMacCacheTmpDir()

		if err := os.MkdirAll(a.userResourcesPath, 0755); err != nil {
			log.Fatalf("failed to create resources dir: %v", err)
		}
		if err := os.MkdirAll(a.tmpPath, 0755); err != nil {
			log.Fatalf("failed to create tmp dir: %v", err)
		}
	case "windows":
		a.resourcesPath = goExecutableDir
		a.userResourcesPath = filepath.Join(os.Getenv("APPDATA"), "HushCut")
		a.tmpPath = filepath.Join(os.Getenv("LOCALAPPDATA"), "HushCut", "tmp")

	case "linux":
		a.resourcesPath = goExecutableDir

		// User settings
		configHome := os.Getenv("XDG_CONFIG_HOME")
		if configHome == "" {
			home, _ := os.UserHomeDir()
			configHome = filepath.Join(home, ".config")
		}
		a.userResourcesPath = filepath.Join(configHome, "HushCut")

		// Temp / cache files
		cacheHome := os.Getenv("XDG_CACHE_HOME")
		if cacheHome == "" {
			home, _ := os.UserHomeDir()
			cacheHome = filepath.Join(home, ".cache")
		}
		a.tmpPath = filepath.Join(cacheHome, "HushCut", "tmp")
	default:
		log.Fatalf("Unsupported platform found during path init: %s", platform)
	}

	// Ensure the directories exist
	if err := os.MkdirAll(a.userResourcesPath, 0755); err != nil {
		log.Fatalf("Failed to create resources folder: %v", err)
	}
	if err := os.MkdirAll(a.tmpPath, 0755); err != nil {
		log.Fatalf("Failed to create tmp folder: %v", err)
	}

	machineID, err := a.getMachineID()
	if err != nil {
		log.Println("Could not retrieve machine ID")
		// alertData := AlertPayload{
		// 	Title:    "Internal Error (no machine ID)",
		// 	Message:  "Could not retrieve the machine ID",
		// 	Severity: "Error",
		// }
		// runtime.EventsEmit(a.ctx, "showAlert", alertData)
	}

	a.machineID = machineID

	a.licenseValid = a.HasAValidLicense()
	if !a.licenseValid {
		runtime.EventsEmit(a.ctx, "license:invalid", nil)
		log.Println("Wails App: License is invalid or not found.")
	}

	a.checkForUpdate("v" + a.appVersion)

	a.installLuaScript()

	// Initialize file usage tracking
	a.loadUsageData()

	var pythonPortArg int

	portStr := os.Getenv("WAILS_PYTHON_PORT")
	if portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err == nil {
			pythonPortArg = port
			log.Printf("Wails App: Detected Python port %d from WAILS_PYTHON_PORT environment variable.", port)
		}
	}

	// If not found via env var, check command-line arguments (for production).
	// This allows the command line to override the env var if needed.
	if pythonPortArg == 0 {
		for i, arg := range os.Args {
			// Handles "--python-port <value>"
			if arg == "--python-port" && i+1 < len(os.Args) {
				port, err := strconv.Atoi(os.Args[i+1])
				if err == nil {
					pythonPortArg = port
					break // Port found
				}
			}
			// Handles "--python-port=<value>"
			if strings.HasPrefix(arg, "--python-port=") {
				valueStr := strings.TrimPrefix(arg, "--python-port=")
				port, err := strconv.Atoi(valueStr)
				if err == nil {
					pythonPortArg = port
					break // Port found
				}
			}
		}
	}

	if pythonPortArg != 0 {
		log.Printf("Wails App: Detected --python-port %d. Will attempt to connect to existing Python backend.", pythonPortArg)
		a.pythonCommandPort = pythonPortArg
	} else {
		log.Println("Wails App: No --python-port flag detected. Will launch and manage the Python backend.")
	}

	log.Println("Wails App: OnStartup called. Offloading backend initialization to a goroutine.")
	// Launch the main initialization logic in a separate goroutine
	go a.initializeBackendsAndPython()
	ffmpegBinName := "ffmpeg"
	if runtime.Environment(a.ctx).Platform == "windows" {
		ffmpegBinName = "ffmpeg.exe"
	}
	a.ffmpegBinaryPath = filepath.Join(a.userResourcesPath, ffmpegBinName)

	if !binaryExists(a.ffmpegBinaryPath) {
		// log.Printf("Primary ffmpeg resolution failed or binary not usable (%v). Falling back to system PATH...", err)
		log.Printf("ffmpeg not found at %s", a.ffmpegBinaryPath)
		a.ffmpegStatus = StatusMissing
		// TODO: figure out how to handle versions (accept locally installed ffmpeg if same minor version?)
		if pathInSystem, lookupErr := exec.LookPath("ffmpeg"); lookupErr == nil && a.ffmpegStatus != StatusMissing {
			a.ffmpegBinaryPath = pathInSystem
			log.Printf("Found ffmpeg in system PATH: %s", a.ffmpegBinaryPath)
			a.ffmpegStatus = StatusReady
		} else {
			//log.Printf("Could not find ffmpeg binary in any known location or system PATH: %v", lookupErr)
			log.Print("no ffmpeg installation in system PATH")
		}

		platform := runtime.Environment(a.ctx).Platform
		if platform == "windows" {
			cmd := exec.Command("cmd", "/c", "where", "ffmpeg")
			out, err := cmd.Output()
			if err == nil && len(out) > 0 {
				cleanPath := strings.TrimSpace(string(out))
				firstPath := strings.Fields(cleanPath)[0]

				a.ffmpegBinaryPath = firstPath
				log.Printf("Found and sanitized ffmpeg path: %s", a.ffmpegBinaryPath)
				a.ffmpegStatus = StatusReady
			} else {
				log.Println("ffmpeg could not be detected: ", err)
			}
		}

	} else {
		log.Printf("ffmpeg found at %s", a.ffmpegBinaryPath)
		a.ffmpegStatus = StatusReady
	}

	runtime.EventsEmit(a.ctx, "ffmpeg:status", a.ffmpegStatus)

	runtime.WindowSetAlwaysOnTop(a.ctx, true)

	log.Println("Wails App: OnStartup method finished. UI should proceed to load.")

}

func (a *App) signalFfmpegReady() {
	a.ffmpegOnce.Do(func() {
		log.Println("Signaling that FFmpeg is now ready.")
		close(a.ffmpegReadyChan)
	})
}

func (a *App) waitForFfmpeg() error {
	a.ffmpegMutex.RLock()
	isReady := a.ffmpegStatus
	a.ffmpegMutex.RUnlock()

	if isReady == StatusReady {
		return nil
	}

	log.Println("Task is waiting for FFmpeg to become available...")
	select {
	case <-a.ffmpegReadyChan:
		log.Println("FFmpeg is now available. Resuming task.")
		return nil
	case <-a.ctx.Done():
		log.Println("Application is shutting down; aborting wait for FFmpeg.")
		return a.ctx.Err()
	}
}

func (a *App) shutdown(ctx context.Context) {
	a.ctx = ctx
	log.Println("Wails App: OnShutdown called.")

	// Save file usage data and clean up old files
	a.cleanupOldFiles()
	a.saveUsageData()

	// Case 1: The Go app launched the Python process. We own it and can terminate it.
	if a.pythonCmd != nil && a.pythonCmd.Process != nil {
		log.Printf("Shutting down Python process with PID %d...", a.pythonCmd.Process.Pid)

		var terminateErr error
		if runtime.Environment(a.ctx).Platform == "windows" {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			a.sendRequestToPython(ctx, "POST", "/shutdown", map[string]interface{}{})
			log.Printf("Attempting to kill Python process tree PID %d...", a.pythonCmd.Process.Pid)
			killCmd := ExecCommand("taskkill", "/PID", strconv.Itoa(a.pythonCmd.Process.Pid), "/T", "/F")
			if err := killCmd.Run(); err != nil {
				log.Printf("taskkill failed: %v", err)
			}
			// Wait for Go to reap process handle
			done := make(chan error)
			go func() { done <- a.pythonCmd.Wait() }()
			select {
			case err := <-done:
				log.Printf("Python process exited: %v", err)
			case <-time.After(5 * time.Second):
				log.Println("Process still alive after taskkill.")
			}
		} else {
			terminateErr = a.pythonCmd.Process.Signal(syscall.SIGTERM) // Graceful shutdown on Unix
		}

		if terminateErr != nil {
			log.Printf("Failed to terminate Python process: %v", terminateErr)
			// send http kill command here as a last resort
			return
		}

		// Wait for graceful shutdown
		done := make(chan error)
		go func() { done <- a.pythonCmd.Wait() }()

		select {
		case err := <-done:
			log.Printf("Python process exited: %v", err)
		case <-time.After(5 * time.Second):
			log.Println("Python process did not exit gracefully; force killing it.")
			if killErr := a.pythonCmd.Process.Kill(); killErr != nil {
				log.Printf("Failed to kill Python process: %v", killErr)
			}
		}
	} else if a.pythonReady {
		log.Println("Signaling external Python backend to shut down...")

		// Create a context with a short, 2-second timeout for this specific request.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		// Use the new, centralized helper function
		_, err := a.sendRequestToPython(shutdownCtx, "POST", "/shutdown", nil)
		if err != nil {
			// Log the error, but don't block the shutdown process.
			log.Printf("Failed to send shutdown signal to Python: %v", err)
		} else {
			log.Println("Successfully sent shutdown signal to Python backend.")
		}
	}
}

func (a *App) initializeBackendsAndPython() {
	log.Println("Go Routine: Starting backend initialization...")

	// Launch Go's HTTP Server
	if err := a.LaunchHttpServer(); err != nil {
		errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to launch Go HTTP server: %v", err)
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
		return
	}
	log.Println("Go Routine: Go HTTP server launch sequence initiated.")
	runtime.EventsEmit(a.ctx, "go:ready", nil)

	goHTTPServerPort := a.GetGoServerPort()
	if goHTTPServerPort == 0 {
		errMsg := "CRITICAL ERROR: Failed to get Go HTTP server port."
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
		return
	}

	// Determine if Python is already running (dev mode)
	if a.pythonCommandPort != 0 {
		log.Printf("Go Routine: Python command server detected on port: %d", a.pythonCommandPort)
		if err := a.registerWithPython(goHTTPServerPort); err != nil {
			errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to register with Python: %v", err)
			log.Println("Go Routine: " + errMsg)
			runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
			return
		}
		a.pythonReady = true
		runtime.EventsEmit(a.ctx, "pythonStatusUpdate", map[string]interface{}{"isReady": true})
	} else {
		// Python is not running, launch it for production
		pythonCmdPort, err := findFreePort()
		if err != nil {
			errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to find free port for Python: %v", err)
			log.Println("Go Routine: " + errMsg)
			runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
			return
		}
		a.pythonCommandPort = pythonCmdPort

		if err := a.LaunchPythonBackend(goHTTPServerPort, a.pythonCommandPort); err != nil {
			errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to launch Python backend: %v", err)
			log.Println("Go Routine: " + errMsg)
			runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
			return
		}

		// Wait for Python's registration signal
		select {
		case <-a.pythonReadyChan:
			log.Println("Go Routine: Python backend has registered successfully.")
			a.pythonReady = true
			runtime.EventsEmit(a.ctx, "pythonStatusUpdate", map[string]interface{}{"isReady": true})
		case <-time.After(30 * time.Second):
			log.Printf("Go Routine Warning: Timed out waiting for Python registration.")
			a.pythonReady = false
		case <-a.ctx.Done():
			log.Println("Go Routine: Application shutdown requested during Python wait.")
			return
		}
	}
	log.Println("Go Routine: Backend initialization complete.")
}

func (a *App) registerWithPython(goPort int) error {
	registrationURL := fmt.Sprintf("http://localhost:%d/register", a.pythonCommandPort)
	payload := map[string]int{"go_server_port": goPort}
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal registration payload: %w", err)
	}

	for i := 0; i < 5; i++ {
		resp, err := http.Post(registrationURL, "application/json", bytes.NewBuffer(jsonPayload))
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				log.Printf("Successfully registered with Python at %s", registrationURL)
				return nil
			}
			body, _ := io.ReadAll(resp.Body)
			log.Printf("Python registration failed with status %d: %s", resp.StatusCode, string(body))
		} else {
			log.Printf("Attempt %d: Could not connect to Python at %s: %v", i+1, registrationURL, err)
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("failed to register with Python after multiple attempts")
}

// reads settings.json. Creates it with defaults if it doesn't exist.
func (a *App) GetSettings() (map[string]any, error) {
	var settingsData map[string]any
	settingsPath := filepath.Join(a.userResourcesPath, "settings.json")

	fileBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist, create it
			defaultSettings := make(map[string]any)
			// Add default key-value pairs here if needed
			defaultSettings["davinciFolderPath"] = ""
			defaultSettings["cleanupThresholdDays"] = 30
			defaultSettings["enableCleanup"] = true

			jsonData, marshalErr := json.MarshalIndent(defaultSettings, "", "  ")
			if marshalErr != nil {
				return nil, fmt.Errorf("failed to marshal default settings: %w", marshalErr)
			}

			dir := filepath.Dir(settingsPath)
			if mkDirErr := os.MkdirAll(dir, 0755); mkDirErr != nil {
				return nil, fmt.Errorf("failed to create settings directory %s: %w", dir, mkDirErr)
			}

			if writeErr := os.WriteFile(settingsPath, jsonData, 0644); writeErr != nil {
				return nil, fmt.Errorf("failed to write default settings file %s: %w", settingsPath, writeErr)
			}
			settingsData = defaultSettings
		} else {
			// Other error reading file
			return nil, fmt.Errorf("failed to read settings file %s: %w", settingsPath, err)
		}
	} else {
		// File exists, unmarshal it
		if unmarshalErr := json.Unmarshal(fileBytes, &settingsData); unmarshalErr != nil {
			// If JSON is malformed, consider returning default or empty settings instead of erroring out.
			return nil, fmt.Errorf("failed to unmarshal settings file %s: %w", settingsPath, unmarshalErr)
		}
	}
	return settingsData, nil
}

// saves the given configuration data to settings.json.
func (a *App) SaveSettings(settingsData map[string]interface{}) error {
	jsonData, err := json.MarshalIndent(settingsData, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal settings data for saving: %w", err)
	}
	settingsPath := filepath.Join(a.userResourcesPath, "settings.json")

	dir := filepath.Dir(settingsPath)
	if mkDirErr := os.MkdirAll(dir, 0755); mkDirErr != nil {
		return fmt.Errorf("failed to create settings directory %s for saving: %w", dir, mkDirErr)
	}

	if err := os.WriteFile(settingsPath, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write settings file %s: %w", settingsPath, err)
	}
	return nil
}

func (a *App) SelectDirectory() (string, error) {
	settings, err := a.GetSettings()
	if err != nil {
		log.Printf("Error getting settings for default directory: %v", err)
	}

	defaultDir := ""
	if davinciPath, ok := settings["davinciFolderPath"].(string); ok && davinciPath != "" {
		info, err := os.Stat(davinciPath)
		if err == nil && info.IsDir() {
			defaultDir = davinciPath
		} else {
			log.Printf("Davinci folder path from settings is not a valid directory or does not exist: %s", davinciPath)
		}
	}

	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		DefaultDirectory: defaultDir,
	})
}

func (a *App) CloseApp() {
	runtime.Quit(a.ctx)
}

func (a *App) GetPythonReadyStatus() bool {
	return a.pythonReady
}

func (a *App) GetFFmpegStatus() FfmpegStatus {
	return a.ffmpegStatus
}

func (a *App) GetAppVersion() string {
	return a.appVersion
}

func (a *App) GetFfmpegVersion() string {
	return a.ffmpegVersion
}

type ProgressStatus struct {
	FilePath   string  `json:"filePath"`
	Percentage float64 `json:"percentage"`
	Error      string  `json:"error,omitempty"`
	TaskType   string  `json:"taskType"`
}

func (a *App) GetCurrentProgressStatus() map[string]float64 {
	progressMap := make(map[string]float64)
	a.progressTracker.Range(func(key, value interface{}) bool {
		filePath := key.(string)
		tracker := value.(*ProgressTracker)

		tracker.mu.RLock() // Lock for reading
		progressMap[filePath] = tracker.Percentage
		tracker.mu.RUnlock() // Unlock

		return true // continue iteration
	})
	return progressMap
}

var durationRegex = regexp.MustCompile(`Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})`)

func parseDuration(s string) (time.Duration, error) {

	matches := durationRegex.FindStringSubmatch(s)

	if len(matches) != 5 {
		return 0, fmt.Errorf("could not parse duration from ffmpeg output: %s", s)
	}

	hours, _ := strconv.Atoi(matches[1])
	minutes, _ := strconv.Atoi(matches[2])
	seconds, _ := strconv.Atoi(matches[3])
	centiseconds, _ := strconv.Atoi(matches[4])

	return time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute + time.Duration(seconds)*time.Second + time.Duration(centiseconds)*10*time.Millisecond, nil

}

type VideoStream struct {
	FFmpegIndex int // actual stream # in ffmpeg
	Width       int
	Height      int
}

type AudioStream struct {
	FFmpegIndex int
	Channels    int
	Layout      string
}

func parseFFmpegStreams(ffmpegOutput string) ([]VideoStream, []AudioStream) {
	videoStreams := []VideoStream{}
	audioStreams := []AudioStream{}

	lines := strings.Split(ffmpegOutput, "\n")

	videoRe := regexp.MustCompile(`Stream #0:(\d+).*Video:`)
	// This single, powerful regex captures all known audio formats.
	// It looks for "stereo", "mono", a layout like "4.0", or the text "X channels".
	audioRe := regexp.MustCompile(`Stream #0:(\d+).*Audio:.*, (stereo|mono|(\d+)\.[\d\.]+|(\d+) channels)`)

	for _, line := range lines {
		if videoRe.MatchString(line) {
			// We only need to know that a video stream exists to offset audio stream indices.
			// No need to parse width/height unless you need it elsewhere.
			videoStreams = append(videoStreams, VideoStream{})

		} else if strings.Contains(line, "Audio:") {
			matches := audioRe.FindStringSubmatch(line)
			if matches == nil {
				// If our smart regex fails, it's an unknown format. Default to 1 channel.
				log.Printf("WARNING: Could not parse channel count for line: %s. Defaulting to 1.", line)

				// Try to at least get the stream index
				simpleIndexRe := regexp.MustCompile(`Stream #0:(\d+)`)
				indexMatches := simpleIndexRe.FindStringSubmatch(line)
				if indexMatches != nil {
					idx, _ := strconv.Atoi(indexMatches[1])
					audioStreams = append(audioStreams, AudioStream{FFmpegIndex: idx, Channels: 1})
				}
				continue
			}

			idx, _ := strconv.Atoi(matches[1])
			layoutStr := matches[2]
			numChannels := 0

			switch {
			case layoutStr == "stereo":
				numChannels = 2
			case layoutStr == "mono":
				numChannels = 1
			case strings.HasSuffix(layoutStr, " channels"):
				// Handles "3 channels"
				fmt.Sscanf(layoutStr, "%d channels", &numChannels)
			default:
				// Handles "4.0", "5.1", etc. We only care about the first number.
				fmt.Sscanf(layoutStr, "%d", &numChannels)
			}

			if numChannels == 0 { // Safety check if Sscanf fails
				numChannels = 1
			}

			audioStreams = append(audioStreams, AudioStream{
				FFmpegIndex: idx,
				Channels:    numChannels,
			})
		}
	}

	return videoStreams, audioStreams
}

func (a *App) StandardizeAudioToWav(inputPath string, outputPath string, sourceChannel *SourceChannel) error {
	tracker := &ProgressTracker{Done: make(chan error, 1)}
	actualTracker, loaded := a.progressTracker.LoadOrStore(outputPath, tracker)

	if loaded {
		// If another goroutine is already working on this, just wait for its result.
		log.Printf("StandardizeAudioToWav: Another task is already handling %s. Waiting.", filepath.Base(outputPath))
		err := <-actualTracker.(*ProgressTracker).Done
		log.Printf("StandardizeAudioToWav: Wait finished for %s.", filepath.Base(outputPath))
		return err
	}

	defer func() {
		close(tracker.Done)
		a.progressTracker.Delete(outputPath)
		log.Printf("StandardizeAudioToWav: Cleaned up tracker for %s.", filepath.Base(outputPath))
	}()

	if err := a.waitForFfmpeg(); err != nil {
		tracker.Done <- err
		return err
	}

	outputFileName := filepath.Base(outputPath)
	go func() {
		_, err := a.GetOrGenerateWaveformWithCache(
			outputFileName,
			128,
			"logarithmic",
			-60.0,
			0.0,
			0,
			math.MaxFloat64,
		)
		if err != nil {
			log.Printf("Error precomputing logarithmic waveform: %v", err)
		}
	}()

	if isValidWavFile(outputPath) {
		tracker.Done <- nil
		return nil
	}

	// 2. Get Duration for Progress Calculation
	infoCmd := ExecCommand(a.ffmpegBinaryPath, "-i", inputPath)
	var infoOutput bytes.Buffer
	infoCmd.Stderr = &infoOutput
	_ = infoCmd.Run() // Ignore error as ffmpeg prints info to stderr even on failure

	totalDuration, err := parseDuration(infoOutput.String())
	if err != nil {
		log.Printf("Could not parse duration for %s, progress will not be available. Error: %v", inputPath, err)
		totalDuration = 0
	}
	totalDurationUs := float64(totalDuration.Microseconds())

	videoStreams, audioStreams := parseFFmpegStreams(infoOutput.String())

	log.Printf("DEBUG: Detected %d audio streams.", len(audioStreams))
	log.Printf("DEBUG: Detected %d video streams for file %s", len(videoStreams), inputPath)
	for i, as := range audioStreams {
		log.Printf("  - Stream %d: %d channels", i, as.Channels)
	}

	streamFound := false
	ffmpegStream := 0
	remaining := sourceChannel.ChannelIndex // 0-based index from Python
	streamIndexInAudioStreams := 0

	for i, aStream := range audioStreams {
		if remaining < aStream.Channels {
			ffmpegStream = len(videoStreams) + i // absolute stream index in ffmpeg
			streamFound = true
			streamIndexInAudioStreams = i // save the index for later
			break
		}
		remaining -= aStream.Channels
	}

	if !streamFound {
		return fmt.Errorf("audio channel index %d is out of bounds for the available streams", sourceChannel.ChannelIndex)
	}

	args := []string{"-y", "-i", inputPath}

	if sourceChannel != nil {
		aStream := audioStreams[streamIndexInAudioStreams]
		log.Printf("Mixing all %d channels from stream %d of '%s'", aStream.Channels, ffmpegStream, filepath.Base(inputPath))

		panExpr := ""
		for ch := 0; ch < aStream.Channels; ch++ {
			if ch > 0 {
				panExpr += "+"
			}
			panExpr += fmt.Sprintf("%g*c%d", 1.0/float64(aStream.Channels), ch)
		}

		afArg := fmt.Sprintf("pan=mono|c0=%s", panExpr)
		args = append(args,
			"-map", fmt.Sprintf("0:%d", ffmpegStream),
			"-af", afArg,
			"-vn",
		)
	} else {
		log.Printf("Standardizing '%s' to mono", filepath.Base(inputPath))
		args = append(args,
			"-af", "pan=mono|c0=0.5*FL+0.5*FR",
			"-vn",
		)
	}

	args = append(args,
		"-acodec", "pcm_s16le",
		"-progress", "pipe:1",
		outputPath,
	)
	log.Printf("FFMPEG FINAL EXTRACT CMD: %s", args)

	cmd := ExecCommand(a.ffmpegBinaryPath, args...)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		tracker.Done <- err
		return err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		tracker.Done <- err
		return err
	}

	if err := cmd.Start(); err != nil {
		tracker.Done <- err
		return err
	}

	// Emit a 0% event immediately so the UI feels responsive
	if totalDurationUs > 0 {
		runtime.EventsEmit(a.ctx, "conversion:progress", ProgressStatus{FilePath: outputPath, Percentage: 0})
	}

	// Goroutine to read and parse progress from stdout
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdoutPipe)
		lastReportedPct := -5.0
		if totalDurationUs <= 0 {
			return
		}

		for scanner.Scan() {
			line := scanner.Text()
			parts := strings.SplitN(line, "=", 2)
			if len(parts) != 2 || strings.TrimSpace(parts[0]) != "out_time_us" {
				continue
			}

			outTimeUs, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
			if err != nil {
				continue
			}

			percentage := (outTimeUs / totalDurationUs) * 100
			if percentage > 100 {
				percentage = 100
			}
			if percentage-lastReportedPct < 2.0 {
				continue
			}

			// Update the central state and emit an event to the frontend
			tracker.mu.Lock()
			tracker.Percentage = percentage
			tracker.mu.Unlock()
			runtime.EventsEmit(a.ctx, "conversion:progress", ProgressStatus{FilePath: outputPath, Percentage: percentage, TaskType: "conversion"})
			lastReportedPct = percentage
		}
	}()

	var stderrBuf bytes.Buffer
	go io.Copy(&stderrBuf, stderrPipe) // Silently consume stderr

	// Wait for completion and signal the result
	err = cmd.Wait()
	wg.Wait() // Ensure the progress scanner has finished reading

	if err != nil {
		finalErr := fmt.Errorf("ffmpeg standardization failed for %s: %w. Stderr: %s", inputPath, err, stderrBuf.String())
		runtime.EventsEmit(a.ctx, "conversion:error", ProgressStatus{FilePath: outputPath, Error: finalErr.Error()})
		tracker.Done <- finalErr
		return finalErr
	}

	// On success, signal 100% and completion
	tracker.mu.Lock()
	tracker.Percentage = 100.0
	tracker.mu.Unlock()
	runtime.EventsEmit(a.ctx, "conversion:done", ProgressStatus{FilePath: outputPath, Percentage: 100})
	tracker.Done <- nil

	// Update file usage timestamp
	a.updateFileUsage(outputPath)
	return nil
}

func (a *App) WaitForFile(path string) error {
	val, ok := a.progressTracker.Load(path)
	if !ok {
		return nil
	}

	log.Printf("Waiting for file to be ready: %s", path)

	tracker, ok := val.(*ProgressTracker)
	if !ok {
		// This should theoretically never happen if we only ever store *ConversionTracker.
		// It acts as a safeguard against unexpected internal errors.
		return fmt.Errorf("internal error: invalid type found in conversion tracker for path %s", path)
	}

	// Wait on the 'Done' channel *within* the struct.
	// This will block until an error is sent or the channel is closed (on success).
	err := <-tracker.Done

	if err != nil {
		return fmt.Errorf("conversion failed for %s: %w", path, err)
	}

	// If err is nil, it means the conversion was successful.
	return nil
}

func (a *App) ProcessProjectAudio(projectData ProjectDataPayload) error {
	log.Println("Starting to standardize ALL project audio streams (including nested)...")

	// --- Step 1: Collect all unique processing jobs from the entire data structure ---
	type audioJob struct {
		SourcePath string
		Channel    *SourceChannel
	}
	// The key is the target output path, which ensures each unique job is only listed once.
	jobsToProcess := make(map[string]audioJob)

	for _, item := range projectData.Timeline.AudioTrackItems {
		// Case 1: This is a simple clip (not a compound clip).
		if item.Type == "" {
			// Use a guard clause to skip if there's no work to do.
			if item.ProcessedFileName == nil || *item.ProcessedFileName == "" {
				continue
			}
			targetWavPath := filepath.Join(a.tmpPath, *item.ProcessedFileName)
			jobsToProcess[targetWavPath] = audioJob{
				SourcePath: item.SourceFilePath,
				Channel:    item.SourceChannel,
			}
			// Mark the processed file as used
			a.updateFileUsage(targetWavPath)
			continue // Move to the next top-level item.
		}

		// Case 2: This is a Compound Clip. Add its nested children to our job list.
		if item.Type != "" && len(item.NestedClips) > 0 {
			for _, nestedItem := range item.NestedClips {
				// Guard clause for nested items.
				if nestedItem.ProcessedFileName == "" {
					continue
				}
				targetWavPath := filepath.Join(a.tmpPath, nestedItem.ProcessedFileName)
				jobsToProcess[targetWavPath] = audioJob{
					SourcePath: nestedItem.SourceFilePath,
					Channel:    nestedItem.SourceChannel,
				}
				// Mark the processed file as used
				a.updateFileUsage(targetWavPath)
			}
		}
	}

	if len(jobsToProcess) == 0 {
		log.Println("No audio streams require standardization.")
		return nil
	}

	// --- Step 2: Execute all collected jobs concurrently ---
	var wg sync.WaitGroup
	errChan := make(chan error, len(jobsToProcess))

	for targetPath, job := range jobsToProcess {
		wg.Add(1)
		// Pass copies of loop variables to the goroutine.
		go func(target string, currentJob audioJob) {
			defer wg.Done()
			a.ffmpegSemaphore <- struct{}{}
			defer func() { <-a.ffmpegSemaphore }()

			if err := a.StandardizeAudioToWav(currentJob.SourcePath, target, currentJob.Channel); err != nil {
				log.Printf("Error standardizing stream for %s: %v", currentJob.SourcePath, err)
				errChan <- err
			}
		}(targetPath, job)
	}

	wg.Wait()
	close(errChan)

	// --- Step 3: Consolidate and report any errors ---
	var conversionErrors []string
	for err := range errChan {
		conversionErrors = append(conversionErrors, err.Error())
	}
	if len(conversionErrors) > 0 {
		runtime.EventsEmit(a.ctx, "conversionError", conversionErrors)
		return fmt.Errorf("encountered %d error(s) during audio standardization:\n%s",
			len(conversionErrors), strings.Join(conversionErrors, "\n"))
	}

	log.Println("All project audio streams standardized successfully.")
	return nil
}

func (a *App) executeMixdownCommand(fps float64, outputPath string, nestedClips []*NestedAudioTimelineItem) error {
	if err := a.waitForFfmpeg(); err != nil {
		return err
	}

	var filterComplex strings.Builder
	var delayedStreams []string

	uniqueSourceFiles := []string{}
	sourceMap := make(map[string]int)

	for _, nc := range nestedClips {
		if nc.ProcessedFileName == "" {
			continue
		}
		if _, found := sourceMap[nc.ProcessedFileName]; !found {
			fullPath := filepath.Join(a.tmpPath, nc.ProcessedFileName)
			sourceMap[nc.ProcessedFileName] = len(uniqueSourceFiles)
			uniqueSourceFiles = append(uniqueSourceFiles, fullPath)
		}
	}

	if len(uniqueSourceFiles) == 0 {
		return fmt.Errorf("no valid processed nested clips found for mixdown into %s", filepath.Base(outputPath))
	}

	log.Printf("Mixdown for '%s' is waiting for %d input file(s) to be ready...", filepath.Base(outputPath), len(uniqueSourceFiles))
	for _, inputFile := range uniqueSourceFiles {
		if err := a.WaitForFile(inputFile); err != nil {
			// If an input file failed to convert, this mixdown cannot proceed.
			return fmt.Errorf("mixdown dependency '%s' failed: %w", filepath.Base(inputFile), err)
		}
	}
	log.Printf("All inputs for mixdown '%s' are ready. Proceeding.", filepath.Base(outputPath))

	for i, nc := range nestedClips {
		if nc.ProcessedFileName == "" {
			continue
		}
		sourceIndex := sourceMap[nc.ProcessedFileName]
		startSec := nc.SourceStartFrame / fps
		durationSec := nc.Duration / fps
		delayMs := (nc.StartFrame / fps) * 1000
		trimStream := fmt.Sprintf("[t%d]", i)
		delayStream := fmt.Sprintf("[d%d]", i)
		trimFilter := fmt.Sprintf("[%d:a]atrim=start=%f:duration=%f,asetpts=PTS-STARTPTS%s;", sourceIndex, startSec, durationSec, trimStream)
		filterComplex.WriteString(trimFilter)
		delayFilter := fmt.Sprintf("%sadelay=%d|%d%s;", trimStream, int(delayMs), int(delayMs), delayStream)
		filterComplex.WriteString(delayFilter)
		delayedStreams = append(delayedStreams, delayStream)
	}

	if len(delayedStreams) == 0 {
		return fmt.Errorf("no streams could be prepared for mixdown into %s", filepath.Base(outputPath))
	}

	mixFilter := fmt.Sprintf("%samix=inputs=%d:dropout_transition=0:normalize=false[out]", strings.Join(delayedStreams, ""), len(delayedStreams))
	filterComplex.WriteString(mixFilter)

	args := []string{"-y"}
	for _, sourceFile := range uniqueSourceFiles {
		args = append(args, "-i", sourceFile)
	}
	args = append(args,
		"-filter_complex", filterComplex.String(),
		"-map", "[out]",
		"-ac", "1",
		outputPath,
	)

	cmd := ExecCommand(a.ffmpegBinaryPath, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg mixdown command failed: %w. Stderr: %s", err, stderr.String())
	}

	return nil
}

func (a *App) MixdownCompoundClips(projectData ProjectDataPayload) error {
	log.Println("Starting mixdown of compound clips...")
	contentMap := make(map[string]*TimelineItem)
	for i, item := range projectData.Timeline.AudioTrackItems {
		if item.Type == "" || len(item.NestedClips) == 0 || item.ProcessedFileName == nil {
			continue
		}
		if _, exists := contentMap[*item.ProcessedFileName]; !exists {
			contentMap[*item.ProcessedFileName] = &projectData.Timeline.AudioTrackItems[i]
		}
	}
	if len(contentMap) == 0 {
		log.Println("No compound clips found to mixdown.")
		return nil
	}

	for processedName, representativeItem := range contentMap {
		outputPath := filepath.Join(a.tmpPath, processedName)

		a.updateFileUsage(outputPath)

		a.ExecuteAndTrackMixdown(projectData.Timeline.ProjectFPS, outputPath, representativeItem.NestedClips)
	}

	log.Println("All mixdown jobs have been dispatched.")
	return nil
}

func (a *App) ExecuteAndTrackMixdown(fps float64, outputPath string, nestedClips []*NestedAudioTimelineItem) {
	tracker := &ProgressTracker{Done: make(chan error, 1)}
	if _, loaded := a.progressTracker.LoadOrStore(outputPath, tracker); loaded {
		return // Job is already running, exit.
	}

	// Launch the actual work in a new goroutine.
	go func() {
		// This goroutine is the "owner" and is responsible for cleanup and signaling.
		defer func() {
			close(tracker.Done)
			a.progressTracker.Delete(outputPath)
		}()

		// Acquire a semaphore slot for the duration of this job
		a.ffmpegSemaphore <- struct{}{}
		defer func() { <-a.ffmpegSemaphore }()

		var err error
		if !isValidWavFile(outputPath) {
			err = a.executeMixdownCommand(fps, outputPath, nestedClips)
		}

		// Signal completion (sends nil on success, or the error on failure)
		tracker.Done <- err
	}()
}
