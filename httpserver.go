// httpserver.go
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const relativeAudioFolderName = "wav_files" // User-defined relative folder

var (
	// These globals are set by LaunchWavAudioServer
	serverListenAddress      string // Stores "localhost:PORT" for display or "IP:PORT" from listener.Addr()
	actualPort               int    // The dynamically assigned port
	effectiveAudioFolderPath string // Resolved absolute path to the audio folder
	isServerInitialized      bool   // Flag to indicate if server init (port assignment) was successful
)

// LaunchWavAudioServer initializes and starts the HTTP server in a goroutine.
// It sets the global actualPort and serverListenAddress if successful.
// Returns an error if listener setup fails.
func LaunchWavAudioServer() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("error getting executable path: %w", err)
	}
	exeDir := filepath.Dir(exePath)
	effectiveAudioFolderPath = filepath.Join(exeDir, relativeAudioFolderName)

	log.Printf("Audio Server: Attempting to serve .wav files from: %s", effectiveAudioFolderPath)

	if _, err := os.Stat(effectiveAudioFolderPath); os.IsNotExist(err) {
		log.Printf("Audio Server Warning: The audio folder '%s' does not exist. Please ensure it's created next to the executable.", effectiveAudioFolderPath)
		// Server will start, but requests for files will fail until the folder exists.
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", audioFileHandlerWails) // Using a slightly renamed handler

	listener, err := net.Listen("tcp", "localhost:0") // OS assigns an available port
	if err != nil {
		return fmt.Errorf("could not start HTTP server listener: %w", err)
	}

	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close() // Clean up
		return fmt.Errorf("listener address is not a TCP address: %v", listener.Addr())
	}
	actualPort = tcpAddr.Port
	// For display consistency, prefer "localhost" if that's what user expects
	serverListenAddress = fmt.Sprintf("localhost:%d", actualPort)
	isServerInitialized = true // Mark that port is assigned and server is about to start

	log.Printf("🎵 Audio Server: Starting on http://%s", serverListenAddress)
	log.Printf("Audio Server: Serving .wav files from: %s", effectiveAudioFolderPath)

	// Start the HTTP server in a new goroutine so it doesn't block
	go func() {
		if errServe := http.Serve(listener, mux); errServe != nil && errServe != http.ErrServerClosed {
			log.Printf("ERROR: Audio Server failed: %v", errServe)
			isServerInitialized = false // Server is no longer considered initialized
			// You might want to signal this failure to the main Wails app
			// if user interaction or state change is needed.
		}
		log.Println("Audio Server: Goroutine finished.")
	}()

	return nil // Listener setup and goroutine launch successful
}

// audioFileHandlerWails is the HTTP handler for serving WAV files.
// It uses the global variables set by LaunchWavAudioServer.
func audioFileHandlerWails(writer http.ResponseWriter, request *http.Request) {
	requestedPath := filepath.Clean(request.URL.Path)

	if strings.Contains(requestedPath, "..") {
		http.Error(writer, "Invalid path", http.StatusBadRequest)
		log.Printf("Audio Server Warning: Path traversal attempt blocked for: %s", request.URL.Path)
		return
	}

	if request.Method != http.MethodGet {
		http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
		log.Printf("Audio Server Warning: Non-GET request (%s) blocked for: %s", request.Method, request.URL.Path)
		return
	}

	if !strings.HasSuffix(strings.ToLower(requestedPath), ".wav") {
		if requestedPath == "/" || requestedPath == "" {
			welcomeMsg := "Welcome to the internal WAV audio server."
			if isServerInitialized && serverListenAddress != "" {
				welcomeMsg += fmt.Sprintf(" Serving from http://%s (folder: %s)", serverListenAddress, effectiveAudioFolderPath)
			} else {
				welcomeMsg += " (Server initializing or encountered an issue)."
			}
			fmt.Fprint(writer, welcomeMsg)
			return
		}
		http.Error(writer, "File type not allowed. Only .wav files are served.", http.StatusForbidden)
		log.Printf("Audio Server Warning: Non-WAV file request blocked: %s", requestedPath)
		return
	}

	fullPath := filepath.Join(effectiveAudioFolderPath, requestedPath)
	absEffectiveAudioFolderPath, err := filepath.Abs(effectiveAudioFolderPath)
	if err != nil {
		http.Error(writer, "Internal server error", http.StatusInternalServerError)
		log.Printf("Audio Server Error: getting absolute path for effectiveAudioFolderPath: %v", err)
		return
	}
	absFullPath, err := filepath.Abs(fullPath)
	if err != nil {
		http.Error(writer, "Internal server error", http.StatusInternalServerError)
		log.Printf("Audio Server Error: getting absolute path for fullPath: %v", err)
		return
	}

	if !strings.HasPrefix(absFullPath, absEffectiveAudioFolderPath) {
		http.Error(writer, "Invalid path (escapes base directory)", http.StatusBadRequest)
		log.Printf("Audio Server Warning: Attempt to access file outside base directory: %s (resolved from %s) vs base %s", requestedPath, absFullPath, absEffectiveAudioFolderPath)
		return
	}

	fileInfo, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		if _, statErr := os.Stat(effectiveAudioFolderPath); os.IsNotExist(statErr) {
			errMsg := fmt.Sprintf("Audio folder '%s' not found. Please ensure it exists next to the executable and is named '%s'.", effectiveAudioFolderPath, relativeAudioFolderName)
			http.Error(writer, errMsg, http.StatusInternalServerError)
			log.Printf("Audio Server Error: Base audio folder not found: %s", effectiveAudioFolderPath)
			return
		}
		http.NotFound(writer, request)
		log.Printf("Audio Server Info: File not found: %s", fullPath)
		return
	}
	if err != nil {
		http.Error(writer, "Internal server error", http.StatusInternalServerError)
		log.Printf("Audio Server Error: accessing file stats for %s: %v", fullPath, err)
		return
	}

	if fileInfo.IsDir() {
		http.Error(writer, "Cannot serve directories", http.StatusForbidden)
		log.Printf("Audio Server Warning: Attempt to access directory: %s", fullPath)
		return
	}

	writer.Header().Set("Content-Type", "audio/wav")
	http.ServeFile(writer, request, fullPath)
	log.Printf("Audio Server Served: %s (Client: %s)", fullPath, request.RemoteAddr)
}