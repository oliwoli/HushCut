package main

import (
	"archive/zip"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
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
