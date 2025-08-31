package main

import (
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
		configDir, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("failed to get user config dir: %v", err)
		}
		base = filepath.Join(configDir, "HushCut")
	}

	_ = os.MkdirAll(base, 0755)

	f, err := os.Create(filepath.Join(base, "log.txt"))
	if err == nil {
		log.SetOutput(f)
	}
}
