package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
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
	ctx                      context.Context
	silenceCache             map[CacheKey][]SilencePeriod
	waveformCache            map[WaveformCacheKey]*PrecomputedWaveformData
	cacheMutex               sync.RWMutex
	configPath               string
	pythonCmd                *exec.Cmd
	pythonReadyChan          chan bool
	pythonReady              bool
	pythonCommandPort        int
	effectiveAudioFolderPath string
	pendingMu                sync.Mutex
	pendingTasks             map[string]chan PythonCommandResponse
	ffmpegBinaryPath         string
	hasFfmpeg                bool
	ffmpegSemaphore          chan struct{}
	waveformSemaphore        chan struct{}
	conversionTracker        sync.Map
}

// NewApp creates a new App application struct
func NewApp() *App {
	configPath := "shared/config.json"

	return &App{
		configPath:               configPath,
		silenceCache:             make(map[CacheKey][]SilencePeriod),
		waveformCache:            make(map[WaveformCacheKey]*PrecomputedWaveformData), // Initialize new cache
		pythonReadyChan:          make(chan bool, 1),                                  // Buffered channel
		pythonReady:              false,
		effectiveAudioFolderPath: "", // FIXME: This needs to be initialized properly!
		pendingTasks:             make(map[string]chan PythonCommandResponse),
		ffmpegSemaphore:          make(chan struct{}, 8),
		waveformSemaphore:        make(chan struct{}, 5),
		conversionTracker:        sync.Map{}, // Initialize the new tracker
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
	determinedPath, err := a.ResolveBinaryPath("python_backend")
	if err != nil {
		return err
	}
	log.Printf("Resolved path to python_backend: %s", determinedPath)

	cmdArgs := []string{
		"--go-port", fmt.Sprintf("%d", port),
		"--listen-on-port", fmt.Sprintf("%d", pythonCommandPort),
	}

	cmd := exec.Command(determinedPath, cmdArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	a.pythonCmd = cmd

	if err := cmd.Start(); err != nil {
		return err
	}
	log.Printf("Go app: Python backend process started (PID: %d, Path: '%s'). Waiting for its HTTP ready signal.\n", cmd.Process.Pid, determinedPath)
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

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Println("Wails App: OnStartup called. Offloading backend initialization to a goroutine.")
	// Launch the main initialization logic in a separate goroutine
	go a.initializeBackendsAndPython()
	var err error
	a.ffmpegBinaryPath, err = a.ResolveBinaryPath("ffmpeg")
	if err != nil || !binaryExists(a.ffmpegBinaryPath) {
		log.Printf("Primary ffmpeg resolution failed or binary not usable (%v). Falling back to system PATH...", err)

		// if pathInSystem, lookupErr := exec.LookPath("ffmpeg"); lookupErr == nil {
		// 	a.ffmpegBinaryPath = pathInSystem
		// 	log.Printf("Found ffmpeg in system PATH: %s", a.ffmpegBinaryPath)
		// 	a.hasFfmpeg = true
		// } else {
		if true {
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

func (a *App) DownloadFFmpeg() error {
	platform := runtime.Environment(a.ctx).Platform
	var url, zipPath, finalBinaryName string

	switch platform {
	case "darwin":
		url = "https://github.com/eihab-abdelhafiz/ffmpeg-static/releases/download/b6.1.1-2/ffmpeg-6.1.1-macos-x86-64.zip"
		zipPath = "ffmpeg-6.1.1-macos-x86-64/ffmpeg"
		finalBinaryName = "ffmpeg"
	case "windows":
		url = "https://github.com/eihab-abdelhafiz/ffmpeg-static/releases/download/b6.1.1-2/ffmpeg-6.1.1-windows-x86-64.zip"
		zipPath = "ffmpeg-6.1.1-windows-x86-64/ffmpeg.exe"
		finalBinaryName = "ffmpeg.exe"
	default:
		return fmt.Errorf("unsupported platform for ffmpeg download: %s", platform)
	}

	// Get the directory of the executable
	goExecutablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not get executable path: %w", err)
	}
	goExecutableDir := filepath.Dir(goExecutablePath)

	var resourceDir string
	switch platform {
	case "darwin":
		resourceDir = filepath.Join(goExecutableDir, "..", "Resources")
	case "windows", "linux":
		resourceDir = goExecutableDir
	}

	// Create the resource directory if it doesn't exist
	if err := os.MkdirAll(resourceDir, 0755); err != nil {
		return fmt.Errorf("could not create resource directory: %w", err)
	}

	finalBinaryPath := filepath.Join(resourceDir, finalBinaryName)

	// Download the zip file
	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("could not download ffmpeg: %w", err)
	}
	defer resp.Body.Close()

	// Create a temporary file to store the zip
	tmpFile, err := os.CreateTemp("", "ffmpeg-*.zip")
	if err != nil {
		return fmt.Errorf("could not create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	// Write the downloaded content to the temp file
	_, err = io.Copy(tmpFile, resp.Body)
	if err != nil {
		return fmt.Errorf("could not write to temp file: %w", err)
	}
	tmpFile.Close()

	// Open the zip file for reading
	r, err := zip.OpenReader(tmpFile.Name())
	if err != nil {
		return fmt.Errorf("could not open zip file: %w", err)
	}
	defer r.Close()

	// Find and extract the ffmpeg binary
	for _, f := range r.File {
		if f.Name == zipPath {
			rc, err := f.Open()
			if err != nil {
				return fmt.Errorf("could not open file in zip: %w", err)
			}
			defer rc.Close()

			outFile, err := os.Create(finalBinaryPath)
			if err != nil {
				return fmt.Errorf("could not create output file: %w", err)
			}
			defer outFile.Close()

			// Make the file executable
			if err := os.Chmod(finalBinaryPath, 0755); err != nil {
				return fmt.Errorf("could not make ffmpeg executable: %w", err)
			}

			_, err = io.Copy(outFile, rc)
			if err != nil {
				return fmt.Errorf("could not copy file from zip: %w", err)
			}

			// Update the app state
			a.ffmpegBinaryPath = finalBinaryPath
			a.hasFfmpeg = true
			runtime.EventsEmit(a.ctx, "ffmpeg:installed", nil)

			return nil
		}
	}

	return fmt.Errorf("could not find ffmpeg binary in zip file")
}

func (a *App) shutdown(ctx context.Context) {
	a.ctx = ctx
	log.Println("Wails App: OnShutdown called.")

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
	}
}

func (a *App) initializeBackendsAndPython() {
	log.Println("Go Routine: Starting backend initialization...")

	// 1. Launch Go's HTTP Server
	if err := a.LaunchHttpServer(a.pythonReadyChan); err != nil {
		errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to launch Go HTTP server: %v", err)
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg) // Notify frontend
		return
	}
	log.Println("Go Routine: Go HTTP server launch sequence initiated.")

	goHTTPServerPort := a.GetGoServerPort()
	if goHTTPServerPort == 0 {
		errMsg := "CRITICAL ERROR: Failed to get Go HTTP server port."
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
		return
	}

	// 2. Determine port for Python's command server
	pythonCmdPort, err := findFreePort()
	if err != nil {
		errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to find free port for Python command server: %v", err)
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
		return
	}
	a.pythonCommandPort = pythonCmdPort
	log.Printf("Go Routine: Python command server will use port: %d", a.pythonCommandPort)

	// 3. Launch Python Backend
	if err := a.LaunchPythonBackend(goHTTPServerPort, a.pythonCommandPort); err != nil {
		errMsg := fmt.Sprintf("CRITICAL ERROR: Failed to launch Python backend: %v", err)
		log.Println("Go Routine: " + errMsg)
		runtime.EventsEmit(a.ctx, "app:criticalError", errMsg)
		return
	}
	log.Println("Go Routine: Python backend launch sequence initiated.")

	// 4. Wait for Python's initial "ready" signal (Python-to-Go)
	pythonReadinessTimeout := 30 * time.Second
	log.Printf("Go Routine: Waiting up to %s for Python to signal readiness...", pythonReadinessTimeout)

	select {
	case <-a.pythonReadyChan:
		log.Println("Go Routine: Python backend has signaled it is ready.")
		a.pythonReady = true
		runtime.EventsEmit(a.ctx, "pythonStatusUpdate", map[string]interface{}{"isReady": true})
	case <-time.After(pythonReadinessTimeout):
		log.Printf("Go Routine Warning: Timed out waiting for Python backend readiness.")
		a.pythonReady = false
		runtime.EventsEmit(a.ctx, "pythonStatusUpdate", map[string]interface{}{"isReady": false, "error": "timeout"})
	case <-a.ctx.Done(): // Main application context cancelled
		log.Println("Go Routine: Application shutdown requested during Python ready wait.")
		return
	}
	log.Println("Go Routine: Backend initialization complete.")
}

// GetConfig reads config.json. Creates it with defaults if it doesn't exist.
func (a *App) GetConfig() (map[string]any, error) {
	var configData map[string]any

	fileBytes, err := os.ReadFile(a.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			// File doesn't exist, create it
			defaultConfig := make(map[string]any)
			// Add default key-value pairs here if needed
			// Example: defaultConfig["theme"] = "dark"

			jsonData, marshalErr := json.MarshalIndent(defaultConfig, "", "  ")
			if marshalErr != nil {
				return nil, fmt.Errorf("failed to marshal default config: %w", marshalErr)
			}

			dir := filepath.Dir(a.configPath)
			if mkDirErr := os.MkdirAll(dir, 0755); mkDirErr != nil {
				return nil, fmt.Errorf("failed to create config directory %s: %w", dir, mkDirErr)
			}

			if writeErr := os.WriteFile(a.configPath, jsonData, 0644); writeErr != nil {
				return nil, fmt.Errorf("failed to write default config file %s: %w", a.configPath, writeErr)
			}
			configData = defaultConfig
		} else {
			// Other error reading file
			return nil, fmt.Errorf("failed to read config file %s: %w", a.configPath, err)
		}
	} else {
		// File exists, unmarshal it
		if unmarshalErr := json.Unmarshal(fileBytes, &configData); unmarshalErr != nil {
			// If JSON is malformed, consider returning default or empty config instead of erroring out.
			return nil, fmt.Errorf("failed to unmarshal config file %s: %w", a.configPath, unmarshalErr)
		}
	}
	return configData, nil
}

// SaveConfig saves the given configuration data to config.json.
func (a *App) SaveConfig(configData map[string]interface{}) error {
	jsonData, err := json.MarshalIndent(configData, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config data for saving: %w", err)
	}

	dir := filepath.Dir(a.configPath)
	if mkDirErr := os.MkdirAll(dir, 0755); mkDirErr != nil {
		return fmt.Errorf("failed to create config directory %s for saving: %w", dir, mkDirErr)
	}

	if err := os.WriteFile(a.configPath, jsonData, 0644); err != nil {
		return fmt.Errorf("failed to write config file %s: %w", a.configPath, err)
	}
	return nil
}

func (a *App) RunPythonScriptWithArgs(args []string) error {
	binaryPath := "python_backend"
	cmd := exec.Command("python3", append([]string{binaryPath}, args...)...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	// Stream stdout
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			runtime.EventsEmit(a.ctx, "python:log", line)
		}
	}()

	// Stream stderr
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			runtime.EventsEmit(a.ctx, "python:log", "[stderr] "+line)
		}
	}()

	// Wait in background
	go func() {
		if err := cmd.Wait(); err != nil {
			log.Printf("Python backend exited with error: %v", err)
		}
	}()

	return nil
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
) ([]SilencePeriod, error) {
	if clipStartSeconds < 0 {
		clipStartSeconds = 0
	}
	if clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("clip end (%.3f) must be greater than start (%.3f)", clipEndSeconds, clipStartSeconds)
	}

	absPath := filepath.Join(a.effectiveAudioFolderPath, filePath)
	loudnessThresholdStr := fmt.Sprintf("%fdB", loudnessThreshold)
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

func (a *App) StandardizeAudioToWav(inputPath string, outputPath string, sourceChannel *int) error {
	// 1. Register with the tracker using our established pattern
	tracker := &ConversionTracker{
		Done: make(chan error, 1),
	}
	actualTracker, loaded := a.conversionTracker.LoadOrStore(outputPath, tracker)
	if loaded {
		return <-actualTracker.(*ConversionTracker).Done
	}
	defer func() {
		close(tracker.Done)
		a.conversionTracker.Delete(outputPath)
	}()

	if isValidWav(outputPath) {
		tracker.Done <- nil
		return nil
	}

	// 2. Get Duration for Progress Calculation
	infoCmd := exec.Command(a.ffmpegBinaryPath, "-i", inputPath)
	var infoOutput bytes.Buffer
	infoCmd.Stderr = &infoOutput
	infoCmd.Run() // We can ignore the error, as ffmpeg errors on no output file but still prints info to stderr

	totalDuration, err := parseDuration(infoOutput.String())
	if err != nil {
		log.Printf("Could not parse duration for %s, progress will not be available. Error: %v", inputPath, err)
		totalDuration = 0
	}
	totalDurationUs := float64(totalDuration.Microseconds())

	// 3. Assemble the correct ffmpeg command (channel-aware or mono-mixdown)
	args := []string{"-y", "-i", inputPath}
	if sourceChannel != nil && *sourceChannel > 0 {
		channelIndex := *sourceChannel - 1
		log.Printf("Extracting channel %d from '%s' using channelmap filter", *sourceChannel, filepath.Base(inputPath))
		mapFilter := fmt.Sprintf("channelmap=map=%d", channelIndex)
		args = append(args, "-af", mapFilter)
	} else {
		log.Printf("Standardizing '%s' to mono", filepath.Base(inputPath))
		args = append(args, "-vn", "-acodec", "pcm_s16le", "-ac", "1")
	}
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

	// On success, signal 100% and completion
	tracker.mu.Lock()
	tracker.Percentage = 100.0
	tracker.mu.Unlock()
	runtime.EventsEmit(a.ctx, "conversion:done", ConversionProgress{FilePath: outputPath, Percentage: 100})
	tracker.Done <- nil
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
			targetWavPath := filepath.Join(a.effectiveAudioFolderPath, *item.ProcessedFileName)
			jobsToProcess[targetWavPath] = audioJob{
				SourcePath: item.SourceFilePath,
				Channel:    item.SourceChannel,
			}
			continue // Move to the next top-level item.
		}

		// Case 2: This is a Compound Clip. Add its nested children to our job list.
		if item.Type != "" && len(item.NestedClips) > 0 {
			for _, nestedItem := range item.NestedClips {
				// Guard clause for nested items.
				if nestedItem.ProcessedFileName == "" {
					continue
				}
				targetWavPath := filepath.Join(a.effectiveAudioFolderPath, nestedItem.ProcessedFileName)
				jobsToProcess[targetWavPath] = audioJob{
					SourcePath: nestedItem.SourceFilePath,
					Channel:    nestedItem.SourceChannel,
				}
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
	var filterComplex strings.Builder
	var delayedStreams []string

	uniqueSourceFiles := []string{}
	sourceMap := make(map[string]int)

	for _, nc := range nestedClips {
		if nc.ProcessedFileName == "" {
			continue
		}
		if _, found := sourceMap[nc.ProcessedFileName]; !found {
			fullPath := filepath.Join(a.effectiveAudioFolderPath, nc.ProcessedFileName)
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

	mixFilter := fmt.Sprintf("%samix=inputs=%d:dropout_transition=0[out]", strings.Join(delayedStreams, ""), len(delayedStreams))
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
		outputPath := filepath.Join(a.effectiveAudioFolderPath, processedName)
		// Kick off the mixdown job for this clip. This call is now non-blocking.
		a.ExecuteAndTrackMixdown(projectData.Timeline.FPS, outputPath, representativeItem.NestedClips)
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
			// This call is now safely happening in the background. It will block here
			// waiting for its inputs, without deadlocking the main app.
			err = a.executeMixdownCommand(fps, outputPath, nestedClips)
		}

		// Signal completion (sends nil on success, or the error on failure)
		tracker.Done <- err
	}()
}
