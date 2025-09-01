package main

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

func init() {
	goExecutablePath, err_exec := os.Executable()
	if err_exec != nil {
		log.Fatalf("Could not get executable path: %v", err_exec)
	}
	goExecutableDir := filepath.Dir(goExecutablePath)

	platform := runtime.GOOS
	base := goExecutableDir

	switch platform {
	case "windows":
		base = filepath.Join(os.Getenv("LOCALAPPDATA"), "HushCut")
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("failed to get home dir: %v", err)
		}
		base = filepath.Join(home, "Library", "Application Support", "HushCut")
	case "linux":
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("failed to get home dir: %v", err)
		}
		configDir := filepath.Join(home, ".local")
		base = filepath.Join(configDir, "HushCut")
	}

	_ = os.MkdirAll(base, 0755)

	logFile, err := os.Create(filepath.Join(base, "log.txt"))
	if err == nil {
		mw := io.MultiWriter(os.Stdout, logFile)
		log.SetOutput(mw)
	}
}
