package main

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}


func (a *App) RunPythonScriptWithArgs(args []string) error {
	scriptPath := "python-backend/src/main.py"

	// Construct the command
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