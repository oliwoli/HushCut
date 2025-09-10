package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

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

func binaryExists(path string) bool {
	if path == "" {
		return false
	}
	cmd := ExecCommand(path, "-version")

	// Correctly discard stdout and stderr
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard

	// cmd.Run() will return nil if the command runs and exits with a zero status code.
	return cmd.Run() == nil
}

func unzip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()

	// Ensure the destination directory exists
	if err := os.MkdirAll(dest, 0755); err != nil {
		return err
	}

	// Iterate through the files in the archive
	for _, f := range r.File {
		fpath := filepath.Join(dest, f.Name)

		// Check for Zip Slip. This is a security vulnerability where a malicious
		// zip file could write files outside of the destination directory.
		if !strings.HasPrefix(fpath, filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("illegal file path: %s", fpath)
		}

		// Create directory if it's a directory
		if f.FileInfo().IsDir() {
			os.MkdirAll(fpath, os.ModePerm)
			continue
		}

		// Create the file's parent directory if it doesn't exist
		if err := os.MkdirAll(filepath.Dir(fpath), os.ModePerm); err != nil {
			return err
		}

		// Create the destination file
		outFile, err := os.OpenFile(fpath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}

		// Open the source file from the zip archive
		rc, err := f.Open()
		if err != nil {
			outFile.Close() // Clean up the created file
			return err
		}

		// Copy the file content
		_, err = io.Copy(outFile, rc)

		// Close the files, important to do this before checking the copy error
		outFile.Close()
		rc.Close()

		if err != nil {
			return err
		}
	}
	return nil
}

//go:embed python-backend/src/HushCut.lua
var luaScriptData []byte

func (a *App) installLuaScript() {
	if len(luaScriptData) == 0 {
		log.Println("Embedded Lua script is empty. Skipping installation.")
		return
	}

	platform := runtime.Environment(a.ctx).Platform
	var destScriptsDir string
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

	destScriptPath := filepath.Join(destScriptsDir, "HushCut.lua")
	existingData, err := os.ReadFile(destScriptPath)
	if err == nil {
		if bytes.Equal(existingData, luaScriptData) {
			log.Printf("Resolve script is already up-to-date at %s", destScriptPath)
			return
		}
	}

	log.Printf("Installing or updating Resolve script at %s", destScriptPath)

	if err := os.MkdirAll(destScriptsDir, 0755); err != nil {
		log.Printf("Failed to create destination directory %s: %v", destScriptsDir, err)
		return
	}

	if err := os.WriteFile(destScriptPath, luaScriptData, 0644); err != nil {
		log.Printf("Failed to write destination script %s: %v", destScriptPath, err)
		return
	}

	log.Println("✅ Successfully installed DaVinci Resolve script.")
}

type FFBinariesResponse struct {
	Version string `json:"version"`
	Bin     map[string]struct {
		FFmpeg string `json:"ffmpeg"`
	} `json:"bin"`
}

func (a *App) DownloadFFmpeg() error {
	if a.ffmpegVersion == "" {
		return fmt.Errorf("a.ffmpegVersion must be set before calling DownloadFFmpeg")
	}

	// Determine the platform and architecture to select the correct binary
	platform := runtime.Environment(a.ctx).Platform // "darwin", "windows", "linux"
	arch := runtime.Environment(a.ctx).Arch         // "amd64", "arm64", etc.

	var platformKey string
	switch platform {
	case "darwin":
		// The API uses "osx-64" for Intel-based Macs.
		// Note: The ffbinaries API does not currently provide native arm64 (Apple Silicon) builds.
		if arch == "amd64" {
			platformKey = "osx-64"
		} else {
			// still just use amd64, should still run on arm systems
			platformKey = "osx-64" // TODO: find another api
			//return fmt.Errorf("unsupported macOS architecture: %s. ffbinaries only supports amd64", arch)
		}
	case "windows":
		if arch == "amd64" {
			platformKey = "windows-64"
		} else {
			return fmt.Errorf("unsupported Windows architecture: %s. ffbinaries only supports amd64", arch)
		}
	case "linux":
		switch arch {
		case "amd64":
			platformKey = "linux-64"
		case "arm64":
			platformKey = "linux-arm64"
		case "arm":
			// NOTE: ffbinaries offers 'linux-armhf' and 'linux-armel'.
			// We are defaulting to 'linux-armhf' which is common for devices like Raspberry Pi.
			platformKey = "linux-armhf"
		case "386":
			platformKey = "linux-32"
		default:
			return fmt.Errorf("unsupported Linux architecture: %s", arch)
		}
	default:
		return fmt.Errorf("unsupported platform for ffmpeg download: %s", platform)
	}
	log.Printf("Resolved platform key for ffbinaries API: %s", platformKey)

	// Fetch the download URL from the ffbinaries API
	apiURL := fmt.Sprintf("https://ffbinaries.com/api/v1/version/%s", a.ffmpegVersion)
	log.Printf("Fetching FFmpeg download info from: %s", apiURL)

	apiResp, err := http.Get(apiURL)
	if err != nil {
		return fmt.Errorf("failed to call ffbinaries API: %w", err)
	}
	defer apiResp.Body.Close()

	if apiResp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(apiResp.Body)
		return fmt.Errorf("ffbinaries API returned non-OK status: %s - %s", apiResp.Status, string(bodyBytes))
	}

	var ffbinariesData FFBinariesResponse
	if err := json.NewDecoder(apiResp.Body).Decode(&ffbinariesData); err != nil {
		return fmt.Errorf("failed to parse ffbinaries API response: %w", err)
	}

	platformInfo, ok := ffbinariesData.Bin[platformKey]
	if !ok || platformInfo.FFmpeg == "" {
		return fmt.Errorf("could not find ffmpeg download URL for platform %s in API response", platformKey)
	}
	downloadURL := platformInfo.FFmpeg

	var installDir = a.userResourcesPath
	finalBinaryName := "ffmpeg"
	if platform == "windows" {
		finalBinaryName = "ffmpeg.exe"
	}

	if err := os.MkdirAll(installDir, 0755); err != nil {
		return fmt.Errorf("could not create install directory at %s: %w", installDir, err)
	}

	// Download and extract in a temporary directory
	tempDir, err := os.MkdirTemp("", "ffmpeg-download-*")
	if err != nil {
		return fmt.Errorf("could not create temporary directory: %w", err)
	}
	defer os.RemoveAll(tempDir) // Clean up temp directory on exit

	downloadPath := filepath.Join(tempDir, "ffmpeg.zip")

	log.Printf("Downloading FFmpeg from %s to %s", downloadURL, downloadPath)
	downloadResp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("could not download ffmpeg zip: %w", err)
	}
	defer downloadResp.Body.Close()

	out, err := os.Create(downloadPath)
	if err != nil {
		return fmt.Errorf("could not create download file: %w", err)
	}

	_, err = io.Copy(out, downloadResp.Body)
	out.Close()
	if err != nil {
		return fmt.Errorf("could not write download to file: %w", err)
	}

	// Extract the archive (all binaries from this API are in .zip format)
	if err := unzip(downloadPath, tempDir); err != nil {
		log.Printf("Unzip failed. Output:\n%s", err)
	}

	// Locate, move, and set permissions for the binary
	extractedFfmpegPath := filepath.Join(tempDir, finalBinaryName)
	if _, err := os.Stat(extractedFfmpegPath); os.IsNotExist(err) {
		return fmt.Errorf("could not find '%s' in the extracted archive", finalBinaryName)
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
	a.ffmpegStatus = StatusReady
	a.signalFfmpegReady()
	runtime.EventsEmit(a.ctx, "ffmpeg:installed", nil)

	log.Println("FFmpeg download and installation complete.")
	return nil
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
	//log.Printf("Updated usage for file: %s", fileName)
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

func isValidWavFile(path string) bool {
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
