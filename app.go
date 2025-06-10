package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	waveformCache            map[WaveformCacheKey]*PrecomputedWaveformData // New cache for waveforms
	cacheMutex               sync.RWMutex                                  // Mutex for thread-safe access to the cache
	configPath               string
	pythonCmd                *exec.Cmd
	pythonReadyChan          chan bool
	pythonReady              bool
	pythonCommandPort        int
	effectiveAudioFolderPath string // Resolved absolute path to the audio folder
	pendingMu                sync.Mutex
	pendingTasks             map[string]chan PythonCommandResponse
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
	}
}

// launch python backend and wait for POST /ready on http server endpoint
func (a *App) LaunchPythonBackend(port int, pythonCommandPort int) error {
	pythonTargetName := "python_backend"

	var determinedPath string

	goExecutablePath, err := os.Executable()
	if err == nil {
		goExecutableDir := filepath.Dir(goExecutablePath)
		pathAlongsideExe := filepath.Join(goExecutableDir, pythonTargetName)

		if _, statErr := os.Stat(pathAlongsideExe); statErr == nil {
			// Found it next to the Go executable!
			determinedPath = pathAlongsideExe
		}
	}

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

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Println("Wails App: OnStartup called. Offloading backend initialization to a goroutine.")

	// Launch the main initialization logic in a separate goroutine
	go a.initializeBackendsAndPython()

	// set window always on top
	runtime.WindowSetAlwaysOnTop(a.ctx, true)

	log.Println("Wails App: OnStartup method finished. UI should proceed to load.")
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
		err := cmd.Wait()
		if err != nil {
			runtime.EventsEmit(a.ctx, "python:done", "Script finished with error: "+err.Error())
		} else {
			runtime.EventsEmit(a.ctx, "python:done", "Script completed successfully.")
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
	clipStartSeconds float64,
	clipEndSeconds float64,
) ([]SilencePeriod, error) {

	if clipStartSeconds < 0 {
		clipStartSeconds = 0
	}

	if clipEndSeconds > 0 && clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("DetectSilences: clipEndSeconds (%.3f) must be greater than clipStartSeconds (%.3f) if a specific end is provided", clipEndSeconds, clipStartSeconds)
	}

	absPath := filepath.Join(a.effectiveAudioFolderPath, filePath)

	// format loudnessThreshold from num to num + "dB"
	loudnessThresholdStr := fmt.Sprintf("%f", loudnessThreshold) + "dB"

	trimFilter := fmt.Sprintf(
		"atrim=start=%f:end=%f",
		clipStartSeconds,
		clipEndSeconds,
	)
	mainFilter := fmt.Sprintf(
		"silencedetect=n=%s:d=%s",
		loudnessThresholdStr,
		fmt.Sprintf("%f", minSilenceDurationSeconds),
	)

	combinedFilter := fmt.Sprintf("%s,%s", trimFilter, mainFilter)

	// outputTarget := "/dev/null"
	// if runtime.Environment(a.ctx).Platform == "windows" {
	// 	outputTarget = "NUL"
	// }

	args := []string{
		"-nostdin",
		"-i", absPath,
		"-af", combinedFilter,
		"-f", "null",
		"-",
	}

	log.Println("FFmpeg command: ", args)

	cmd := exec.Command("ffmpeg", args...)
	var outputBuffer bytes.Buffer
	cmd.Stdout = &outputBuffer
	cmd.Stderr = &outputBuffer

	err := cmd.Run()
	output := outputBuffer.String()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg processing failed: %w. Output: %s", err, output)
	}

	detectedSilences := []SilencePeriod{}

	silenceStartRegex := regexp.MustCompile(`silence_start:\s*([0-9]+\.?[0-9]*)`)
	silenceEndRegex := regexp.MustCompile(`silence_end:\s*([0-9]+\.?[0-9]*)`)

	scanner := bufio.NewScanner(strings.NewReader(output))
	var currentStartTime float64 = -1

	for scanner.Scan() {
		line := scanner.Text()
		startMatch := silenceStartRegex.FindStringSubmatch(line)
		if len(startMatch) > 1 {
			startTime, parseErr := strconv.ParseFloat(startMatch[1], 64)
			if parseErr == nil {
				currentStartTime = startTime
			}
		}

		endMatch := silenceEndRegex.FindStringSubmatch(line)
		if len(endMatch) > 1 && currentStartTime != -1 {
			endTime, parseErr := strconv.ParseFloat(endMatch[1], 64)
			if parseErr == nil {
				adjustedStartTime := currentStartTime + paddingLeftSeconds
				adjustedEndTime := endTime - paddingRightSeconds
				if adjustedStartTime < adjustedEndTime {
					detectedSilences = append(detectedSilences, SilencePeriod{
						Start: adjustedStartTime,
						End:   adjustedEndTime,
					})
				}
				currentStartTime = -1
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading ffmpeg output: %w", err)
	}

	return detectedSilences, nil
}

func (a *App) GetOrDetectSilencesWithCache(
	filePath string,
	loudnessThreshold float64,
	minSilenceDurationSeconds float64,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
) ([]SilencePeriod, error) {
	key := CacheKey{
		FilePath:                  filePath,
		LoudnessThreshold:         loudnessThreshold,
		MinSilenceDurationSeconds: minSilenceDurationSeconds,
		PaddingLeftSeconds:        paddingLeftSeconds,
		PaddingRightSeconds:       paddingRightSeconds,
		ClipStartSeconds:          clipStartSeconds,
		ClipEndSeconds: 		   clipEndSeconds,
	}

	// 1. Try to read from cache (read lock)
	a.cacheMutex.RLock()
	cachedSilences, found := a.silenceCache[key]
	a.cacheMutex.RUnlock()

	if found {
		// fmt.Println("Cache hit for key:", key.FilePath, key.LoudnessThreshold, key.MinSilenceDurationSeconds) // For debugging
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
func (a *App) GetLogarithmicWaveform(filePath string, samplesPerPixel int, minDb float64, clipStartSeconds float64, clipEndSeconds float64) (*PrecomputedWaveformData, error) {
	maxDb := 0.0 // Consistent with original function; this is now passed to the caching layer.

	// The caching function GetOrGenerateWaveformWithCache will handle path resolution
	data, err := a.GetOrGenerateWaveformWithCache(filePath, samplesPerPixel, minDb, maxDb, clipStartSeconds, clipEndSeconds)
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
	if _, statErr := os.Stat(localFSPath); os.IsNotExist(statErr) {
		return nil, fmt.Errorf("audio file does not exist at resolved path '%s' (from '%s')", localFSPath, webInputPath)
	} else if statErr != nil {
		return nil, fmt.Errorf("error stating file at resolved path '%s': %w", localFSPath, statErr)
	}

	// The cache key uses the original webInputPath as the primary identifier.
	key := WaveformCacheKey{
		FilePath:         webInputPath, // Use the URL/web path for the key
		SamplesPerPixel:  samplesPerPixel,
		MinDb:            minDb,
		MaxDb:            maxDb,
		ClipStartSeconds: clipStartSeconds,
		ClipEndSeconds:   clipEndSeconds,
	}

	a.cacheMutex.RLock()
	cachedData, found := a.waveformCache[key]
	a.cacheMutex.RUnlock()

	if found {
		// log.Printf("Waveform Cache HIT for: %s, Samples: %d", webInputPath, samplesPerPixel)
		return cachedData, nil
	}
	// log.Printf("Waveform Cache MISS for: %s, Samples: %d", webInputPath, samplesPerPixel)

	// If not found, perform the generation.
	// Pass the original webInputPath to ProcessWavToLogarithmicPeaks, as it handles its own path resolution.
	waveformData, err := a.ProcessWavToLogarithmicPeaks(webInputPath, samplesPerPixel, minDb, maxDb, clipStartSeconds, clipEndSeconds)
	if err != nil {
		// Do not cache errors, so subsequent calls can retry.
		return nil, fmt.Errorf("error during waveform peak processing for '%s': %w", webInputPath, err)
	}

	a.cacheMutex.Lock()
	a.waveformCache[key] = waveformData
	a.cacheMutex.Unlock()

	return waveformData, nil
}

func (a *App) GetPythonReadyStatus() bool {
	return a.pythonReady
}
