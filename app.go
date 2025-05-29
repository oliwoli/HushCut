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

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx          context.Context
	silenceCache map[CacheKey][]SilencePeriod
	cacheMutex   sync.RWMutex // Mutex for thread-safe access to the cache
	configPath   string
}

// NewApp creates a new App application struct
func NewApp() *App {
	// Config path is relative to the CWD of the running application.
	// For built apps, consider a more robust path (e.g., using os.UserConfigDir()).
	configPath := "shared/config.json"
	return &App{configPath: configPath, silenceCache: make(map[CacheKey][]SilencePeriod)}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	log.Println("Wails App: OnStartup called.")
	log.Println("Wails App: Initializing and launching internal WAV audio server...")

	if err := LaunchWavAudioServer(); err != nil {
		// The server failed to even set up its listener. This is critical.
		errMsg := fmt.Sprintf("FATAL: Failed to launch WAV audio server: %v", err)
		log.Println(errMsg)
		// For a real app, you might want to show a critical error dialog to the user.
		// Example: runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		//     Type:    runtime.ErrorDialog,
		//     Title:   "Critical Error",
		//     Message: "The internal audio server could not be started. Audio playback will not work.\nError: " + err.Error(),
		// })
		// And potentially os.Exit(1) or disable features.
	} else {
		log.Println("Wails App: WAV audio server launch sequence initiated.")
	}
}

func (a *App) GetAudioServerPort() int {
	if !isServerInitialized {
		log.Println("Wails App: GetAudioServerPort called, but server is not (yet) initialized or failed to start. Returning 0.")
		return 0 // Or -1, or some other indicator that it's not ready
	}
	return actualPort // Accesses the global from httpserver.go
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
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
	scriptPath := "python-backend/src/main.py"
	cmd := exec.Command("python3", append([]string{scriptPath}, args...)...)

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

func DetectSilences(
	filePath string,
	loudnessThreshold string,
	minSilenceDurationSeconds string,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
) ([]SilencePeriod, error) {
	// ... (ffmpeg setup, LookPath check etc.) ...

	args := []string{
		"-nostdin",
		"-i", filePath,
		"-af", fmt.Sprintf("silencedetect=n=%s:d=%s", loudnessThreshold, minSilenceDurationSeconds),
		"-f", "null",
		"-",
	}

	cmd := exec.Command("ffmpeg", args...)
	var outputBuffer bytes.Buffer
	cmd.Stdout = &outputBuffer
	cmd.Stderr = &outputBuffer

	// --- Recommended: Improved Error Handling (see point 2 below) ---
	err := cmd.Run()
	output := outputBuffer.String() // Get output for parsing or error messages

	if err != nil {
		// ffmpeg failed to run or exited with an error code.
		// The 'output' string might contain useful error details from ffmpeg.
		return nil, fmt.Errorf("ffmpeg processing failed: %w. Output: %s", err, output)
	}
	// --- End of Recommended Error Handling ---

	// --- PRIMARY FIX HERE ---
	// Initialize as an empty, non-nil slice
	detectedSilences := []SilencePeriod{}
	// OLD way that results in nil: var detectedSilences []SilencePeriod

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
		// Return nil for data if there was a scanner error, plus the error
		return nil, fmt.Errorf("error reading ffmpeg output: %w", err)
	}

	// If no silences were found, detectedSilences is now an empty slice [], not nil
	return detectedSilences, nil
}

func (a *App) GetOrDetectSilencesWithCache(
	filePath string,
	loudnessThreshold string,
	minSilenceDurationSeconds string,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
) ([]SilencePeriod, error) {
	key := CacheKey{
		FilePath:                  filePath,
		LoudnessThreshold:         loudnessThreshold,
		MinSilenceDurationSeconds: minSilenceDurationSeconds,
		PaddingLeftSeconds:        paddingLeftSeconds,
		PaddingRightSeconds:       paddingRightSeconds,
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
	// Note: We call the standalone DetectSilences function here.
	// If DetectSilences itself could be long-running and called by multiple goroutines
	// for the *same missing key* simultaneously, you might want a more complex
	// single-flight mechanism. For simplicity, this lock-after-check is common.
	silences, err := DetectSilences(filePath, loudnessThreshold, minSilenceDurationSeconds, paddingLeftSeconds, paddingRightSeconds)
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
func (a *App) GetLogarithmicWaveform(filePath string, samplesPerPixel int, minDb float64) (*PrecomputedWaveformData, error) {
	// `PrecomputedWaveformData` type is accessible because it's defined in waveform.go (package main) and exported.
	// `ProcessWavToLogarithmicPeaks` function is accessible for the same reason.

	runtime.LogInfof(a.ctx, "Generating logarithmic waveform for: %s (spp: %d, minDb: %.1f)", filePath, samplesPerPixel, minDb)

	// maxDisplayDb is typically 0.0 for 0dBFS (full scale)
	maxDb := 0.0

	data, err := ProcessWavToLogarithmicPeaks(filePath, samplesPerPixel, minDb, maxDb)
	if err != nil {
		runtime.LogError(a.ctx, fmt.Sprintf("Error generating waveform data for %s: %v", filePath, err))
		// It's often better to return the error message clearly to the frontend
		return nil, fmt.Errorf("failed to generate waveform for '%s': %v", filePath, err)
	}

	runtime.LogInfof(a.ctx, "Successfully generated waveform for: %s, Duration: %.2f, Peaks count: %d", filePath, data.Duration, len(data.Peaks))
	return data, nil
}