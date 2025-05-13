package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx        context.Context
	configPath string
}

// NewApp creates a new App application struct
func NewApp() *App {
	// Config path is relative to the CWD of the running application.
	// For built apps, consider a more robust path (e.g., using os.UserConfigDir()).
	configPath := "shared/config.json"
	return &App{configPath: configPath}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
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