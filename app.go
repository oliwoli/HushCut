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

// App struct
type App struct {
	ctx     context.Context
	isDev   bool
	testApi bool

	appVersion string
	updateInfo *UpdateResponseV1

	licenseMutex     sync.Mutex // Mutex to protect license operations
	licenseVerifyKey []byte     // Public key for verifying license file signatures
	licenseValid     bool
	licenseOkChan    chan bool // Channel to signal license validity

	silenceCache      map[CacheKey][]SilencePeriod
	waveformCache     map[WaveformCacheKey]*PrecomputedWaveformData
	cacheMutex        sync.RWMutex
	pythonCmd         *exec.Cmd
	pythonReadyChan   chan bool
	pythonReady       bool
	pythonCommandPort int
	resourcesPath     string // → a.appResourcesPath (immutable, inside bundle)
	userResourcesPath string // → Application Support or config dir (writable)
	tmpPath           string
	pendingMu         sync.Mutex
	pendingTasks      map[string]chan PythonCommandResponse
	ffmpegBinaryPath  string
	hasFfmpeg         bool
	ffmpegSemaphore   chan struct{}
	waveformSemaphore chan struct{}
	conversionTracker sync.Map
	fileUsage         map[string]time.Time // New field for file usage tracking
	mu                sync.Mutex           // Mutex to protect fileUsage

	// -- HTTP -- //
	httpClient *http.Client
	authToken  string

	// --- FFmpeg STATE ---
	ffmpegMutex     sync.RWMutex  // Protects hasFfmpeg flag
	ffmpegReadyChan chan struct{} // Used to signal when FFmpeg is ready
	ffmpegOnce      sync.Once     // Ensures the ready channel is closed only once
	// ----- //

}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		licenseOkChan:     make(chan bool, 1), // Buffered channel to avoid blocking
		silenceCache:      make(map[CacheKey][]SilencePeriod),
		waveformCache:     make(map[WaveformCacheKey]*PrecomputedWaveformData), // Initialize new cache
		pythonReadyChan:   make(chan bool, 1),                                  // Buffered channel
		pythonReady:       false,
		tmpPath:           "", // Will be initialized in startup
		pendingTasks:      make(map[string]chan PythonCommandResponse),
		ffmpegSemaphore:   make(chan struct{}, 8),
		waveformSemaphore: make(chan struct{}, 3),
		conversionTracker: sync.Map{}, // Initialize the new tracker
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		ffmpegReadyChan: make(chan struct{}),

		appVersion: AppVersion,
		fileUsage:  make(map[string]time.Time),
	}
}

func (a *App) SetWindowAlwaysOnTop(alwaysOnTop bool) {
	runtime.WindowSetAlwaysOnTop(a.ctx, alwaysOnTop)
}

func (a *App) OpenURL(url string) {
	runtime.BrowserOpenURL(a.ctx, url)
}

type ConversionTracker struct {
	mu         sync.RWMutex // Protects access to the percentage
	Percentage float64
	Done       chan error
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

	cmd := exec.Command(pythonBinaryPath, cmdArgs...)
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
		return 0 // Or -1, or some other indicator that it's not ready
	}
	return actualPort // Accesses the global from httpserver.go
}

func binaryExists(path string) bool {
	if path == "" {
		return false
	}
	cmd := exec.Command(path, "-version")
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

//go:embed python-backend/src/HushCut.lua
var luaScriptData []byte

func (a *App) installLuaScript() {
	// The source script data is now embedded directly in the binary.
	if len(luaScriptData) == 0 {
		log.Println("Embedded Lua script is empty. Skipping installation.")
		return
	}

	// 1. Determine the correct destination directory (logic is unchanged)
	platform := runtime.Environment(a.ctx).Platform
	var destScriptsDir string
	// ... switch statement for platform is the same as before ...
	switch platform {
	case "darwin":
		homeDir, err := os.UserHomeDir()
		if err != nil {
			log.Printf("Could not get user home directory on macOS: %v", err)
			return
		}
		destScriptsDir = filepath.Join(homeDir, "Library", "Application Support", "Blackmagic Design", "DaVinci Resolve", "Fusion", "Scripts", "Edit")

	case "windows":
		appDataDir := os.Getenv("APPDATA")
		if appDataDir == "" {
			log.Println("Could not resolve %APPDATA% directory on Windows.")
			return
		}
		destScriptsDir = filepath.Join(appDataDir, "Blackmagic Design", "DaVinci Resolve", "Support", "Fusion", "Scripts", "Edit")

	case "linux":
		homeDir, err := os.UserHomeDir()
		if err != nil {
			log.Printf("Could not get user home directory on Linux: %v", err)
			return
		}
		destScriptsDir = filepath.Join(homeDir, ".local", "share", "DaVinciResolve", "Fusion", "Scripts", "Edit")

	default:
		log.Printf("Resolve script installation not supported on this platform: %s", platform)
		return
	}

	// 2. Check if the script needs to be copied by comparing file content
	destScriptPath := filepath.Join(destScriptsDir, "HushCut.lua")
	existingData, err := os.ReadFile(destScriptPath)
	if err == nil {
		// File exists, now compare its content with the embedded script
		if bytes.Equal(existingData, luaScriptData) {
			log.Printf("Resolve script is already up-to-date at %s", destScriptPath)
			return
		}
	}

	log.Printf("Installing or updating Resolve script at %s", destScriptPath)

	// 3. Ensure the destination directory exists
	if err := os.MkdirAll(destScriptsDir, 0755); err != nil {
		log.Printf("Failed to create destination directory %s: %v", destScriptsDir, err)
		return
	}

	// 4. Write the embedded data to the destination
	if err := os.WriteFile(destScriptPath, luaScriptData, 0644); err != nil {
		log.Printf("Failed to write destination script %s: %v", destScriptPath, err)
		return
	}

	log.Println("✅ Successfully installed DaVinci Resolve script.")
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	envInfo := runtime.Environment(ctx)
	if envInfo.BuildType == "production" {
		fmt.Print("|> HushCut v" + a.GetAppVersion() + " - Production Build \n")
		a.isDev = false
	} else {
		fmt.Print("|> HushCut v" + a.GetAppVersion() + " - Development Build \n")
		a.isDev = true
	}

	// Initialize tmp and resources path based on platform
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
		a.tmpPath = filepath.Join(os.TempDir(), "HushCut")

		if err := os.MkdirAll(a.userResourcesPath, 0755); err != nil {
			log.Fatalf("failed to create resources dir: %v", err)
		}
		if err := os.MkdirAll(a.tmpPath, 0755); err != nil {
			log.Fatalf("failed to create tmp dir: %v", err)
		}
	case "windows", "linux":
		a.resourcesPath = goExecutableDir
		a.userResourcesPath = filepath.Join(goExecutableDir, ".hushcut_res")
		a.tmpPath = filepath.Join(a.userResourcesPath, "tmp")
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

	a.licenseValid = a.HasAValidLicense()
	if !a.licenseValid {
		runtime.EventsEmit(a.ctx, "license:invalid", nil)
		log.Println("Wails App: License is invalid or not found. (Prompt for license on frontend)")
	}

	a.checkForUpdate("v" + a.appVersion)

	a.installLuaScript()

	// Initialize file usage tracking
	a.loadUsageData()

	var pythonPortArg int

	// First, check for the environment variable (ideal for `wails dev`).
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
	var err error
	a.ffmpegBinaryPath = filepath.Join(a.userResourcesPath, "ffmpeg")
	if a.ffmpegBinaryPath == "" || !binaryExists(a.ffmpegBinaryPath) {
		log.Printf("Primary ffmpeg resolution failed or binary not usable (%v). Falling back to system PATH...", err)

		// TODO: enable this code when in production
		if pathInSystem, lookupErr := exec.LookPath("ffmpeg"); lookupErr == nil {
			a.ffmpegBinaryPath = pathInSystem
			log.Printf("Found ffmpeg in system PATH: %s", a.ffmpegBinaryPath)
			a.hasFfmpeg = true
		} else {
			//log.Printf("Could not find ffmpeg binary in any known location or system PATH: %v", lookupErr)
			a.hasFfmpeg = false
			log.Print("no ffmpeg installation")
			runtime.EventsEmit(a.ctx, "ffmpeg:missing", nil)
		}
	} else {
		a.hasFfmpeg = true
	}

	// set window always on top
	runtime.WindowSetAlwaysOnTop(a.ctx, true)

	log.Println("Wails App: OnStartup method finished. UI should proceed to load.")

}

func moveFile(sourcePath, destPath string) error {
	inputFile, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("couldn't open source file: %w", err)
	}
	defer inputFile.Close()

	outputFile, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("couldn't open dest file: %w", err)
	}
	defer outputFile.Close()

	_, err = io.Copy(outputFile, inputFile)
	if err != nil {
		return fmt.Errorf("writing to dest file failed: %w", err)
	}

	// The copy was successful, so now we delete the original file
	err = os.Remove(sourcePath)
	if err != nil {
		// This is not a critical error if the copy succeeded, but good to log.
		log.Printf("Warning: failed to remove original source file after copy: %s", sourcePath)
	}
	return nil
}

func (a *App) signalFfmpegReady() {
	a.ffmpegOnce.Do(func() {
		log.Println("Signaling that FFmpeg is now ready.")
		close(a.ffmpegReadyChan)
	})
}

func (a *App) signalLicenseOk() {
	log.Println("Signaling that license is now valid.")
	a.licenseValid = true
	a.licenseOkChan <- true
	runtime.EventsEmit(a.ctx, "license:valid", nil)
}

func (a *App) waitForValidLicense() error {
	a.licenseMutex.Lock()
	isReady := a.licenseValid
	a.licenseMutex.Unlock()

	if isReady {
		return nil // License valid, proceed.
	}

	// If not ready, block and wait for the signal.
	log.Println("Task is waiting for License activation...")
	select {
	case <-a.licenseOkChan:
		log.Println("License activated. Resuming task.")
		return nil
	case <-a.ctx.Done():
		log.Println("Application is shutting down; aborting License activation.")
		return a.ctx.Err()
	}
}

func (a *App) waitForFfmpeg() error {
	a.ffmpegMutex.RLock()
	isReady := a.hasFfmpeg
	a.ffmpegMutex.RUnlock()

	if isReady {
		return nil // FFmpeg already available, proceed.
	}

	// If not ready, block and wait for the signal.
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

func (a *App) DownloadFFmpeg() error {
	platform := runtime.Environment(a.ctx).Platform
	var url string
	var finalBinaryName string
	var extractCmd *exec.Cmd
	var tempDir string

	goExecutablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not get executable path: %w", err)
	}
	goExecutableDir := filepath.Dir(goExecutablePath)

	var installDir string
	switch platform {
	case "darwin":
		url = "https://evermeet.cx/ffmpeg/getrelease/zip"
		finalBinaryName = "ffmpeg"
		installDir = filepath.Join(goExecutableDir, "..", "Resources")
	case "windows":
		url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z"
		finalBinaryName = "ffmpeg.exe"
		installDir = goExecutableDir
	case "linux":
		url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
		finalBinaryName = "ffmpeg"
		installDir = goExecutableDir
	default:
		return fmt.Errorf("unsupported platform for ffmpeg download: %s", platform)
	}

	// Create install directory if it doesn't exist
	if err := os.MkdirAll(installDir, 0755); err != nil {
		return fmt.Errorf("could not create install directory: %w", err)
	}

	// Create a temporary directory for download and extraction
	tempDir, err = os.MkdirTemp("", "ffmpeg-download-")
	if err != nil {
		return fmt.Errorf("could not create temporary directory: %w", err)
	}
	defer os.RemoveAll(tempDir) // Clean up temp directory

	downloadPath := filepath.Join(tempDir, filepath.Base(url))

	// Download the file
	log.Printf("Downloading FFmpeg from %s to %s", url, downloadPath)
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("could not download ffmpeg: %w", err)
	}
	defer resp.Body.Close()

	out, err := os.Create(downloadPath)
	if err != nil {
		return fmt.Errorf("could not create download file: %w", err)
	}

	_, err = io.Copy(out, resp.Body)
	if err != nil {
		out.Close()
		return fmt.Errorf("could not write download to file: %w", err)
	}
	out.Close() // Close the file before extraction

	// Extract the archive
	switch platform {
	case "darwin":
		extractCmd = exec.Command("unzip", downloadPath, "-d", tempDir)
	case "windows":
		extractCmd = exec.Command("7z", "x", downloadPath, "-o"+tempDir)
	case "linux":
		extractCmd = exec.Command("tar", "-xf", downloadPath, "-C", tempDir)
	}

	log.Printf("Extracting FFmpeg with command: %v", extractCmd.Args)
	extractCmd.Stdout = os.Stdout
	extractCmd.Stderr = os.Stderr
	if err := extractCmd.Run(); err != nil {
		return fmt.Errorf("failed to extract ffmpeg archive: %w", err)
	}

	// Find the extracted ffmpeg binary
	var extractedFfmpegPath string
	switch platform {
	case "darwin":
		extractedFfmpegPath = filepath.Join(tempDir, finalBinaryName)
	case "windows":
		entries, err := os.ReadDir(tempDir)
		if err != nil {
			return fmt.Errorf("failed to read temp directory after 7z extraction: %w", err)
		}
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), "ffmpeg-") {
				extractedFfmpegPath = filepath.Join(tempDir, entry.Name(), "bin", finalBinaryName)
				break
			}
		}
	case "linux":
		entries, err := os.ReadDir(tempDir)
		if err != nil {
			return fmt.Errorf("failed to read temp directory after tar extraction: %w", err)
		}
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), "ffmpeg-") {
				extractedFfmpegPath = filepath.Join(tempDir, entry.Name(), finalBinaryName)
				break
			}
		}
	}

	if extractedFfmpegPath == "" || extractedFfmpegPath == tempDir {
		return fmt.Errorf("could not find ffmpeg binary in extracted archive")
	}

	log.Printf("Moving FFmpeg from %s to %s", extractedFfmpegPath, a.ffmpegBinaryPath)
	if err := moveFile(extractedFfmpegPath, a.ffmpegBinaryPath); err != nil {
		return fmt.Errorf("failed to move ffmpeg binary: %w", err)
	}

	if platform != "windows" {
		if err := os.Chmod(a.ffmpegBinaryPath, 0755); err != nil {
			return fmt.Errorf("could not make ffmpeg executable: %w", err)
		}
	}

	// Update the app state
	a.hasFfmpeg = true
	a.signalFfmpegReady()
	runtime.EventsEmit(a.ctx, "ffmpeg:installed", nil)

	log.Println("FFmpeg download and installation complete.")
	return nil
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
			terminateErr = a.pythonCmd.Process.Kill() // Immediate kill on Windows
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

	// 1. Launch Go's HTTP Server
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

	// 2. Determine if Python is already running (dev mode)
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

// GetSettings reads settings.json. Creates it with defaults if it doesn't exist.
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

// SaveSettings saves the given configuration data to settings.json.
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
		// Log the error but don't prevent the dialog from opening
		log.Printf("Error getting settings for default directory: %v", err)
	}

	defaultDir := ""
	if davinciPath, ok := settings["davinciFolderPath"].(string); ok && davinciPath != "" {
		// Check if the path exists and is a directory
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
	// Close the app
	runtime.Quit(a.ctx)
	// Optionally, you can also perform any cleanup tasks here
}

func (a *App) DetectSilences(
	filePath string,
	loudnessThreshold float64,
	minSilenceDurationSeconds float64,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
	minContentDuration float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
	framerate float64,
) ([]SilencePeriod, error) {
	if err := a.waitForValidLicense(); err != nil {
		return nil, fmt.Errorf("license validation failed: %w", err)
	}

	if err := a.waitForFfmpeg(); err != nil {
		return nil, err
	}

	if clipStartSeconds < 0 {
		clipStartSeconds = 0
	}
	if clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("clip end (%.3f) must be greater than start (%.3f)", clipEndSeconds, clipStartSeconds)
	}

	absPath := filepath.Join(a.tmpPath, filePath)
	// Mark the input file as used after its absolute path is determined
	a.updateFileUsage(absPath)
	loudnessThresholdStr := fmt.Sprintf("%fdB", loudnessThreshold)
	if minSilenceDurationSeconds < 0.009 {
		minSilenceDurationSeconds = 0.009
	}

	minSilenceDurationForFFmpeg := fmt.Sprintf("%f", minSilenceDurationSeconds)

	filterGraph := fmt.Sprintf("atrim=start=%.6f:end=%.6f,silencedetect=n=%s:d=%s",
		clipStartSeconds, clipEndSeconds,
		loudnessThresholdStr, minSilenceDurationForFFmpeg,
	)

	args := []string{
		"-nostdin", "-i", absPath, "-af", filterGraph, "-f", "null", "-",
	}
	cmd := exec.Command(a.ffmpegBinaryPath, args...)
	var outputBuffer bytes.Buffer
	cmd.Stderr = &outputBuffer

	if err := cmd.Run(); err != nil && len(outputBuffer.String()) == 0 {
		return nil, fmt.Errorf("ffmpeg failed: %w. Output: %s", err, outputBuffer.String())
	}

	var preliminarySilences []SilencePeriod
	silenceStartRegex := regexp.MustCompile(`silence_start:\s*([0-9]+\.?[0-9]*)`)
	silenceEndRegex := regexp.MustCompile(`silence_end:\s*([0-9]+\.?[0-9]*)`)
	scanner := bufio.NewScanner(&outputBuffer)

	var currentStartTime float64 = -1
	const epsilon = 0.001

	for scanner.Scan() {
		line := scanner.Text()
		if match := silenceStartRegex.FindStringSubmatch(line); len(match) > 1 {
			start, _ := strconv.ParseFloat(match[1], 64)
			currentStartTime = start // ✅ CORRECTED: Timestamps are absolute, no offset needed.
		}

		if match := silenceEndRegex.FindStringSubmatch(line); len(match) > 1 && currentStartTime != -1 {
			endTime, _ := strconv.ParseFloat(match[1], 64)

			adjustedStart := currentStartTime
			adjustedEnd := endTime

			if adjustedStart > clipStartSeconds+epsilon {
				adjustedStart += paddingLeftSeconds
			}
			if adjustedEnd < clipEndSeconds-epsilon {
				adjustedEnd -= paddingRightSeconds
			}

			adjustedStart = math.Max(adjustedStart, clipStartSeconds)
			adjustedEnd = math.Min(adjustedEnd, clipEndSeconds)

			if adjustedEnd-adjustedStart >= minSilenceDurationSeconds {
				preliminarySilences = append(preliminarySilences, SilencePeriod{
					Start: adjustedStart,
					End:   adjustedEnd,
				})
			}
			currentStartTime = -1
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading ffmpeg output: %w", err)
	}

	if len(preliminarySilences) == 0 {
		return []SilencePeriod{}, nil
	}

	if first := preliminarySilences[0]; first.Start-clipStartSeconds > epsilon && first.Start-clipStartSeconds < minContentDuration {
		preliminarySilences[0].Start = clipStartSeconds
	}
	if last := preliminarySilences[len(preliminarySilences)-1]; clipEndSeconds-last.End > epsilon && clipEndSeconds-last.End < minContentDuration {
		preliminarySilences[len(preliminarySilences)-1].End = clipEndSeconds
	}

	var mergedSilences []SilencePeriod
	if len(preliminarySilences) > 0 {
		current := preliminarySilences[0]
		for i := 1; i < len(preliminarySilences); i++ {
			next := preliminarySilences[i]
			if contentDuration := next.Start - current.End; contentDuration < minContentDuration {
				current.End = next.End
			} else {
				mergedSilences = append(mergedSilences, current)
				current = next
			}
		}
		mergedSilences = append(mergedSilences, current)
	}

	return mergedSilences, nil
}

func (a *App) GetOrDetectSilencesWithCache(
	filePath string,
	loudnessThreshold float64,
	minSilenceDurationSeconds float64,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
	minContentDuration float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
	framerate float64,
) ([]SilencePeriod, error) {
	key := CacheKey{
		FilePath:                  filePath,
		LoudnessThreshold:         loudnessThreshold,
		MinSilenceDurationSeconds: minSilenceDurationSeconds,
		PaddingLeftSeconds:        paddingLeftSeconds,
		PaddingRightSeconds:       paddingRightSeconds,
		MinContentDuration:        minContentDuration,
		ClipStartSeconds:          clipStartSeconds,
		ClipEndSeconds:            clipEndSeconds,
	}

	// 1. Try to read from cache (read lock)
	a.cacheMutex.RLock()
	cachedSilences, found := a.silenceCache[key]
	a.cacheMutex.RUnlock()

	if found {
		//fmt.Println("Cache hit for key:", key.FilePath, key.LoudnessThreshold, key.MinSilenceDurationSeconds) // For debugging
		return cachedSilences, nil
	}

	// fmt.Println("Cache miss for key:", key.FilePath, key.LoudnessThreshold, key.MinSilenceDurationSeconds) // For debugging

	// 2. If not found, perform the detection
	silences, err := a.DetectSilences(
		filePath,
		loudnessThreshold,
		minSilenceDurationSeconds,
		paddingLeftSeconds,
		paddingRightSeconds,
		minContentDuration,
		clipStartSeconds,
		clipEndSeconds,
		framerate,
	)
	if err != nil {
		// Do not cache errors, so subsequent calls can retry.
		return nil, err
	}

	// 3. Store the result in the cache (write lock)
	a.cacheMutex.Lock()
	a.silenceCache[key] = silences
	a.cacheMutex.Unlock()
	return silences, nil
}

// New method to be called from Wails frontend
func (a *App) GetWaveform(filePath string, samplesPerPixel int, peakType string, minDb float64, clipStartSeconds float64, clipEndSeconds float64) (*PrecomputedWaveformData, error) {
	maxDb := 0.0 // Consistent with original function; this is now passed to the caching layer.

	if err := a.WaitForFile(filePath); err != nil {
		return nil, fmt.Errorf("error waiting for file to be ready for silence detection: %w", err)
	}

	// The caching function GetOrGenerateWaveformWithCache will handle path resolution
	data, err := a.GetOrGenerateWaveformWithCache(filePath, samplesPerPixel, peakType, minDb, maxDb, clipStartSeconds, clipEndSeconds)
	if err != nil {
		runtime.LogError(a.ctx, fmt.Sprintf("Error getting or generating waveform data for %s: %v", filePath, err))
		return nil, fmt.Errorf("failed to get/generate waveform for '%s': %v", filePath, err)
	}

	// runtime.LogInfof(a.ctx, "Successfully retrieved/generated waveform for: %s, Duration: %.2fs, Peaks: %d",
	//  filePath, data.Duration, len(data.Peaks))
	return data, nil
}

func (a *App) GetOrGenerateWaveformWithCache(
	webInputPath string,
	samplesPerPixel int,
	peakType string,
	minDb float64,
	maxDb float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
) (*PrecomputedWaveformData, error) {
	// First, resolve the webInputPath to a local file system path to check for existence.
	// This also validates if effectiveAudioFolderPath is set.
	localFSPath, err := a.resolvePublicAudioPath(webInputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve web input path '%s' for pre-check: %w", webInputPath, err)
	}
	// Mark the input file as used after its absolute path is determined
	a.updateFileUsage(localFSPath)

	if err := a.WaitForFile(localFSPath); err != nil {
		return nil, fmt.Errorf("error waiting for file '%s' to be ready: %w", webInputPath, err)
	}

	if _, statErr := os.Stat(localFSPath); os.IsNotExist(statErr) {
		return nil, fmt.Errorf("audio file does not exist at resolved path '%s' (from '%s')", localFSPath, webInputPath)
	} else if statErr != nil {
		return nil, fmt.Errorf("error stating file at resolved path '%s': %w", localFSPath, statErr)
	}

	// The cache key uses the original webInputPath as the primary identifier.
	key := WaveformCacheKey{
		FilePath:         webInputPath,
		SamplesPerPixel:  samplesPerPixel,
		PeakType:         peakType,
		MinDb:            minDb,
		MaxDb:            maxDb,
		ClipStartSeconds: clipStartSeconds,
		ClipEndSeconds:   clipEndSeconds,
	}

	a.cacheMutex.RLock()
	cachedData, found := a.waveformCache[key]
	a.cacheMutex.RUnlock()

	if found {
		return cachedData, nil
	}

	// --- CACHE MISS: Decide which processor to call ---
	a.waveformSemaphore <- struct{}{}
	defer func() {
		<-a.waveformSemaphore // Release semaphore
	}()

	var waveformData *PrecomputedWaveformData

	switch peakType {
	case "linear":
		waveformData, err = a.ProcessWavToLinearPeaks(webInputPath, samplesPerPixel, clipStartSeconds, clipEndSeconds)
	case "logarithmic":
		waveformData, err = a.ProcessWavToLogarithmicPeaks(webInputPath, samplesPerPixel, minDb, maxDb, clipStartSeconds, clipEndSeconds)
	default:
		err = fmt.Errorf("unknown peakType: '%s'", peakType)
	}

	if err != nil {
		return nil, fmt.Errorf("error during waveform processing for '%s': %w", webInputPath, err)
	}

	a.cacheMutex.Lock()
	a.waveformCache[key] = waveformData
	a.cacheMutex.Unlock()

	return waveformData, nil
}

func (a *App) GetPythonReadyStatus() bool {
	return a.pythonReady
}

func (a *App) GetFFmpegStatus() bool {
	return a.hasFfmpeg
}

const fileUsageFileName = "file_usage.json"

func (a *App) updateFileUsage(filePath string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Ensure the path is absolute and clean
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		log.Printf("Error getting absolute path for file usage: %v", err)
		return
	}

	// CRITICAL SAFETY CHECK: Only track files within tmp path
	if !strings.HasPrefix(absPath, a.tmpPath) {
		log.Printf("WARNING: Attempted to track file outside tmp path. Skipping: %s", absPath)
		return
	}

	// Store only the base filename as the key
	fileName := filepath.Base(absPath)
	a.fileUsage[fileName] = time.Now()
	log.Printf("Updated usage for file: %s", fileName)
}

func (a *App) GetAppVersion() string {
	return a.appVersion
}

func (a *App) getFileUsagePath() string {
	return filepath.Join(a.tmpPath, fileUsageFileName)
}

func (a *App) loadUsageData() {
	a.mu.Lock()
	defer a.mu.Unlock()

	filePath := a.getFileUsagePath()
	log.Printf("Attempting to load file usage data from: %s", filePath)

	data, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Println("file_usage.json does not exist. Initializing empty usage data.")
			a.fileUsage = make(map[string]time.Time)
			return
		}
		log.Printf("Error reading file_usage.json: %v", err)
		return
	}

	var rawUsage map[string]string
	if err := json.Unmarshal(data, &rawUsage); err != nil {
		log.Printf("Error unmarshaling file_usage.json: %v", err)
		return
	}

	// Check if rawUsage is empty after unmarshaling
	if len(rawUsage) == 0 {
		log.Println("file_usage.json is empty or contains no valid entries. Initializing empty usage data.")
		a.fileUsage = make(map[string]time.Time)
		return
	}

	a.fileUsage = make(map[string]time.Time)
	for fileName, v := range rawUsage {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			log.Printf("Error parsing time for %s: %v", fileName, err)
			continue
		}
		// Reconstruct the full path for internal use
		fullPath := filepath.Join(a.tmpPath, fileName)
		a.fileUsage[fullPath] = t
	}
	log.Printf("Successfully loaded %d entries from file_usage.json", len(a.fileUsage))
}

func (a *App) saveUsageData() {
	a.mu.Lock()
	defer a.mu.Unlock()

	filePath := a.getFileUsagePath()
	//log.Printf("Attempting to save file usage data to: %s. Number of entries: %d", filePath, len(rawUsage))

	rawUsage := make(map[string]string)
	for fullPath, v := range a.fileUsage {
		fileName := filepath.Base(fullPath)
		rawUsage[fileName] = v.Format(time.RFC3339)
	}

	data, err := json.MarshalIndent(rawUsage, "", "  ")
	if err != nil {
		log.Printf("Error marshaling file usage data: %v", err)
		return
	}

	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("Error creating directory for file_usage.json: %v", err)
		return
	}

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		log.Printf("Error writing file_usage.json: %v", err)
		return
	}
	log.Println("Successfully saved file usage data.")
}

func (a *App) cleanupOldFiles() {
	a.mu.Lock()
	defer a.mu.Unlock()

	log.Println("Starting cleanup of old temporary files...")
	now := time.Now()

	settings, err := a.GetSettings()
	if err != nil {
		log.Printf("Error getting settings for cleanup threshold: %v", err)
		// Fallback to default if settings can't be read
		settings = make(map[string]any)
		settings["cleanupThresholdDays"] = 14
		settings["enableCleanup"] = true // Default to true if settings can't be read
	}

	enableCleanup := true
	if val, ok := settings["enableCleanup"].(bool); ok {
		enableCleanup = val
	}

	if !enableCleanup {
		log.Println("Cleanup of old temporary files is disabled by settings.")
		return
	}

	cleanupThresholdDays := 14                                     // Default value
	if val, ok := settings["cleanupThresholdDays"].(float64); ok { // JSON numbers are float64 in Go
		cleanupThresholdDays = int(val)
	} else if val, ok := settings["cleanupThresholdDays"].(int); ok {
		cleanupThresholdDays = val
	}

	cleanupThreshold := time.Duration(cleanupThresholdDays) * 24 * time.Hour
	log.Printf("Cleanup threshold set to %d days (%v)", cleanupThresholdDays, cleanupThreshold)

	filesToDelete := []string{}
	for filePath, lastUsed := range a.fileUsage {
		if now.Sub(lastUsed) > cleanupThreshold {
			filesToDelete = append(filesToDelete, filePath)
		}
	}

	for _, filePath := range filesToDelete {
		log.Printf("Deleting old file: %s (last used %s ago)", filePath, now.Sub(a.fileUsage[filePath]))
		if err := os.Remove(filePath); err != nil {
			log.Printf("Error deleting file %s: %v", filePath, err)
			// if "no such file" error, remove from fileUsage map
			if os.IsNotExist(err) {
				delete(a.fileUsage, filePath)
			}
		} else {
			delete(a.fileUsage, filePath)
		}
	}
	log.Printf("Cleanup complete. Deleted %d old files.", len(filesToDelete))
}

func isValidWav(path string) bool {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false // File doesn't exist
	}
	if err != nil {
		log.Printf("Error stating file %s: %v", path, err)
		return false // Some other error
	}
	// Exists and is not an empty file
	return !info.IsDir() && info.Size() > 44 // 44 bytes is a common WAV header size
}

type ConversionProgress struct {
	FilePath   string  `json:"filePath"` // The final ABSOLUTE output path
	Percentage float64 `json:"percentage"`
	Error      string  `json:"error,omitempty"`
}

func (a *App) GetCurrentConversionProgress() map[string]float64 {
	progressMap := make(map[string]float64)
	a.conversionTracker.Range(func(key, value interface{}) bool {
		filePath := key.(string)
		tracker := value.(*ConversionTracker)

		tracker.mu.RLock() // Lock for reading
		progressMap[filePath] = tracker.Percentage
		tracker.mu.RUnlock() // Unlock

		return true // continue iteration
	})
	return progressMap
}

// In app.go - Replace your existing StandardizeAudioToWav function

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

// calculateMP3DelaySec calculates the specific delay for MP3 files.
// It uses a set of hardcoded values for known sample rates from the user's
// provided data for perfect accuracy, and falls back to a predictive model
// for all other sample rates.
func calculateMP3DelaySec(sampleRate int) float64 {
	return 0.0
	//Use a switch for high performance and clarity.
	// switch sampleRate {
	// // --- Hardcoded values from your delay-data.csv for perfect precision ---
	// case 8000:
	// 	return 0.210
	// case 16000:
	// 	return 0.104994792
	// case 44100:
	// 	return 0.051177083
	// case 48000:
	// 	return 0.047015625
	// default:
	// 	// --- Fallback to the predictive model for any other sample rate ---
	// 	// This ensures we can handle any MP3 file gracefully.
	// 	const a = 1.30299795e+07
	// 	const k = 1.24413193
	// 	const b = 28.43853540

	// 	fs := float64(sampleRate)

	// 	// Calculate the delay in milliseconds using the model.
	// 	delayMilliseconds := (a / math.Pow(fs, k)) + b

	// 	// Convert the delay from milliseconds to seconds.
	// 	return delayMilliseconds / 1000.0
	// }
}

func (a *App) getStartTimeWithFFmpeg(inputPath string) (float64, error) {
	cmd := exec.Command(a.ffmpegBinaryPath, "-i", inputPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	_ = cmd.Run()

	output := stderr.String()

	// Regex for "start: <value>"
	re := regexp.MustCompile(`(?m)start:\s+([0-9.]+)`)
	matches := re.FindStringSubmatch(output)
	if len(matches) >= 2 {
		startTime := strings.TrimSpace(matches[1])
		return strconv.ParseFloat(startTime, 64)
	}

	// Fallback regex for "pts_time:<value>"
	rePTS := regexp.MustCompile(`(?m)pts_time:([0-9.]+)`)
	matches = rePTS.FindStringSubmatch(output)
	if len(matches) >= 2 {
		startTime := strings.TrimSpace(matches[1])
		return strconv.ParseFloat(startTime, 64)
	}

	return 0.0, fmt.Errorf("start time not found in ffmpeg output")
}

func (a *App) createSilenceFile(tempDir string, delaySec float64, sampleRate int, outputPath string) (string, error) {
	filename := filepath.Base(outputPath)

	silencePath := filepath.Join(tempDir, fmt.Sprintf("silence_%s.wav", filename))
	durationStr := fmt.Sprintf("%.9f", delaySec)

	cmd := exec.Command(a.ffmpegBinaryPath,
		"-f", "lavfi",
		"-i", fmt.Sprintf("anullsrc=channel_layout=mono:sample_rate=%d", sampleRate),
		"-t", durationStr,
		"-y", silencePath)

	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to generate silence WAV: %w\n%s", err, output)
	}
	return silencePath, nil
}

func (a *App) StandardizeAudioToWav(inputPath string, outputPath string, sourceChannel *int) error {
	tracker := &ConversionTracker{Done: make(chan error, 1)}
	actualTracker, loaded := a.conversionTracker.LoadOrStore(outputPath, tracker)

	if loaded {
		// If another goroutine is already working on this, just wait for its result.
		log.Printf("StandardizeAudioToWav: Another task is already handling %s. Waiting.", filepath.Base(outputPath))
		err := <-actualTracker.(*ConversionTracker).Done
		log.Printf("StandardizeAudioToWav: Wait finished for %s.", filepath.Base(outputPath))
		return err
	}

	// This goroutine is now the "owner" of the conversion task.
	// We must ensure the Done channel is closed and the tracker entry is removed.
	defer func() {
		close(tracker.Done)
		a.conversionTracker.Delete(outputPath)
		log.Printf("StandardizeAudioToWav: Cleaned up tracker for %s.", filepath.Base(outputPath))
	}()

	// 2. NOW, wait for FFmpeg to be ready.
	if err := a.waitForFfmpeg(); err != nil {
		// If waiting fails (e.g., app quits), signal the error to any waiters.
		tracker.Done <- err
		return err
	}

	if isValidWav(outputPath) {
		tracker.Done <- nil
		return nil
	}

	// 2. Get Duration for Progress Calculation
	infoCmd := exec.Command(a.ffmpegBinaryPath, "-i", inputPath)
	var infoOutput bytes.Buffer
	infoCmd.Stderr = &infoOutput
	_ = infoCmd.Run() // Ignore error as ffmpeg prints info to stderr even on failure
	infoStr := infoOutput.String()

	totalDuration, err := parseDuration(infoOutput.String())
	if err != nil {
		log.Printf("Could not parse duration for %s, progress will not be available. Error: %v", inputPath, err)
		totalDuration = 0
	}
	totalDurationUs := float64(totalDuration.Microseconds())

	// --- START OF MODIFIED LOGIC ---
	var startTime float64

	// Regex to find the audio stream, its codec, and sample rate.

	reAudioStream := regexp.MustCompile(`Stream #\d+:\d+.*: Audio: (\w+).*?(\d+)\s+Hz`)
	matches := reAudioStream.FindStringSubmatch(infoStr)

	var sampleRate int = 44100 // Default sample rate if not found
	// Check if the audio stream is MP3.
	if len(matches) >= 3 && matches[1] == "mp3" {
		codec := matches[1]
		sampleRateStr := matches[2]
		sampleRate, err = strconv.Atoi(sampleRateStr)
		if err == nil && sampleRate > 0 {
			// If it's an MP3, use the custom calculation.
			startTime = calculateMP3DelaySec(sampleRate)
			log.Printf("Detected MP3 audio stream (codec: %s, rate: %d Hz). Applying calculated delay of %.6f seconds.", codec, sampleRate, startTime)
		}
	}

	// If startTime is still 0, it's not an MP3 or parsing failed. Fall back to the original metadata method.
	if startTime == 0.0 {
		log.Printf("File is not MP3 or info not found; falling back to metadata start_time.")
		startTime, err = a.getStartTimeWithFFmpeg(inputPath)
		if err != nil {
			log.Printf("Could not get start time for %s via metadata: %v", inputPath, err)
			startTime = 0.0 // Default to 0 if we can't determine it
		}
	}

	// 3. Assemble the correct ffmpeg command (channel-aware or mono-mixdown)
	args := []string{
		"-y",
		"-i", inputPath,
	}

	var filterChain []string

	tempDir := os.TempDir()

	// 2. Add channel mapping or mono mixdown filters to the SAME chain.
	if sourceChannel != nil && *sourceChannel > 0 {
		channelIndex := *sourceChannel - 1
		log.Printf("Extracting channel %d from '%s' using channelmap filter", *sourceChannel, filepath.Base(inputPath))
		mapFilter := fmt.Sprintf("channelmap=map=%d", channelIndex)
		filterChain = append(filterChain, mapFilter)
	} else {
		// For a standard mono mixdown, it's cleaner to use the 'pan' filter
		// than the '-ac 1' output option when other filters are in use.
		log.Printf("Standardizing '%s' to mono", filepath.Base(inputPath))
		panFilter := "pan=mono|c0=0.5*FL+0.5*FR"
		filterChain = append(filterChain, panFilter)
	}

	// 3. If we have any filters in our chain, join them with commas and add them to the args.
	if len(filterChain) > 0 {
		finalFilterString := strings.Join(filterChain, ",")
		args = append(args, "-af", finalFilterString)
	}

	// 4. Add the final output codec and other options.
	// The -acodec option is now outside the if/else block for clarity.
	args = append(args, "-acodec", "pcm_s16le")
	// Add the progress flag and output path to complete the command
	args = append(args, "-progress", "pipe:1", outputPath)

	// 4. Execute the command and process its output
	cmd := exec.Command(a.ffmpegBinaryPath, args...)

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
		runtime.EventsEmit(a.ctx, "conversion:progress", ConversionProgress{FilePath: outputPath, Percentage: 0})
	}

	// 5. Goroutine to read and parse progress from stdout
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
			runtime.EventsEmit(a.ctx, "conversion:progress", ConversionProgress{FilePath: outputPath, Percentage: percentage})
			lastReportedPct = percentage
		}
	}()

	var stderrBuf bytes.Buffer
	go io.Copy(&stderrBuf, stderrPipe) // Silently consume stderr

	// 6. Wait for completion and signal the result
	err = cmd.Wait()
	wg.Wait() // Ensure the progress scanner has finished reading

	if err != nil {
		finalErr := fmt.Errorf("ffmpeg standardization failed for %s: %w. Stderr: %s", inputPath, err, stderrBuf.String())
		runtime.EventsEmit(a.ctx, "conversion:error", ConversionProgress{FilePath: outputPath, Error: finalErr.Error()})
		tracker.Done <- finalErr
		return finalErr
	}

	// Now handle silence and concat
	if startTime > 0 {
		//startTime *= 2
		log.Printf("Detected start time %.6f for '%s'. Adding silence at the beginning.", startTime, filepath.Base(inputPath))
		silenceWav, err := a.createSilenceFile(tempDir, startTime, sampleRate, outputPath)
		if err != nil {
			log.Printf("Failed to create silence file for '%s': %v", filepath.Base(inputPath), err)
			tracker.Done <- err
			return err
		}
		// rename the outputPath to a temporary, intermediate file
		tempOutputPath := outputPath + ".temp.wav"
		if err := os.Rename(outputPath, tempOutputPath); err != nil {
			tracker.Done <- fmt.Errorf("failed to rename output file: %w", err)
			return err
		}
		concatListPath := filepath.Join(tempDir, "concat_list.txt")
		concatContent := fmt.Sprintf("file '%s'\nfile '%s'\n", silenceWav, tempOutputPath)
		if err := os.WriteFile(concatListPath, []byte(concatContent), 0644); err != nil {
			tracker.Done <- err
			return err
		}

		concatCmd := exec.Command(a.ffmpegBinaryPath,
			"-f", "concat", "-safe", "0", "-i", concatListPath,
			"-acodec", "pcm_s16le", "-y", outputPath)

		concatOut, err := concatCmd.CombinedOutput()
		defer os.Remove(tempOutputPath)
		defer os.Remove(silenceWav)
		defer os.Remove(concatListPath)
		if err != nil {
			tracker.Done <- fmt.Errorf("concat failed: %w\n%s", err, concatOut)
			return err
		}
		log.Printf("Successfully concatenated silence to '%s'.", filepath.Base(outputPath))
	}

	// On success, signal 100% and completion
	tracker.mu.Lock()
	tracker.Percentage = 100.0
	tracker.mu.Unlock()
	runtime.EventsEmit(a.ctx, "conversion:done", ConversionProgress{FilePath: outputPath, Percentage: 100})
	tracker.Done <- nil

	// Update file usage timestamp
	a.updateFileUsage(outputPath)

	return nil
}

func (a *App) WaitForFile(path string) error {
	val, ok := a.conversionTracker.Load(path)
	if !ok {
		return nil
	}

	// It's in the tracker, so we wait for the conversion to finish.
	log.Printf("Waiting for file to be ready: %s", path)

	// 1. Correctly assert the value to our tracker struct type.
	tracker, ok := val.(*ConversionTracker)
	if !ok {
		// This should theoretically never happen if we only ever store *ConversionTracker.
		// It acts as a safeguard against unexpected internal errors.
		return fmt.Errorf("internal error: invalid type found in conversion tracker for path %s", path)
	}

	// 2. Wait on the 'Done' channel *within* the struct.
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
		Channel    *int
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

	cmd := exec.Command(a.ffmpegBinaryPath, args...)
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

	// This function now just dispatches the mixdown jobs.
	// It does not need to wait for them or handle their errors directly,
	// as any part of the app that needs the file will wait and get the error.
	for processedName, representativeItem := range contentMap {
		outputPath := filepath.Join(a.tmpPath, processedName)

		// Mark the processed file as used
		a.updateFileUsage(outputPath)

		// Kick off the mixdown job for this clip. This call is now non-blocking.
		a.ExecuteAndTrackMixdown(projectData.Timeline.ProjectFPS, outputPath, representativeItem.NestedClips)
	}

	log.Println("All mixdown jobs have been dispatched.")
	return nil
}

func (a *App) ExecuteAndTrackMixdown(fps float64, outputPath string, nestedClips []*NestedAudioTimelineItem) {
	// 1. Register the job. If another process is already working on this, we don't need to do anything.
	tracker := &ConversionTracker{Done: make(chan error, 1)}
	if _, loaded := a.conversionTracker.LoadOrStore(outputPath, tracker); loaded {
		return // Job is already running, exit.
	}

	// 2. Launch the actual work in a new goroutine.
	go func() {
		// This goroutine is the "owner" and is responsible for cleanup and signaling.
		defer func() {
			close(tracker.Done)
			a.conversionTracker.Delete(outputPath)
		}()

		// Acquire a semaphore slot for the duration of this job
		a.ffmpegSemaphore <- struct{}{}
		defer func() { <-a.ffmpegSemaphore }()

		var err error
		if !isValidWav(outputPath) {
			err = a.executeMixdownCommand(fps, outputPath, nestedClips)
		}

		// Signal completion (sends nil on success, or the error on failure)
		tracker.Done <- err
	}()
}
