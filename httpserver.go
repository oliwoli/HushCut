// httpserver.go
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const relativeAudioFolderName = "wav_files" // User-defined relative folder

var (
	serverListenAddress string // Stores "localhost:PORT" for display or "IP:PORT" from listener.Addr()
	actualPort          int    // port for audio server + messages from python backend to go
	isServerInitialized bool   // Flag to indicate if server init (port assignment) was successful
)

// --- Data Structures for Python Messages ---
type PythonMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"` // Delay parsing payload until type is known
}

// Payload for toasts/progress
type ToastPayload struct {
	Message   string `json:"message"`
	ToastType string `json:"toastType,omitempty"` // e.g., "info", "success", "warning", "error"
}

// Payload for alerts/popups
type AlertPayload struct {
	Title    string `json:"title"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // e.g., "info", "warning", "error"
}

// Payload for your main project/timeline data (customize as needed)
type ClipInfo struct {
	Name        string  `json:"name"`
	FilePath    string  `json:"filePath"` // Absolute path to the audio file for Go to serve
	TimelineIn  float64 `json:"timelineIn"`
	TimelineOut float64 `json:"timelineOut"`
	SourceIn    float64 `json:"sourceIn"`
	SourceOut   float64 `json:"sourceOut"`
}

// type ProjectDataPayload struct {
// 	ProjectName     string     `json:"projectName"`
// 	TimelineName    string     `json:"timelineName"`
// 	SampleRate      int        `json:"sampleRate"`
// 	DurationSeconds float64    `json:"durationSeconds"`
// 	Clips           []ClipInfo `json:"clips"`
// }

// --- End Data Structures ---

func commonMiddleware(next http.HandlerFunc, endpointRequiresAuth bool) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		// 1. Set CORS Headers
		// 'actualPort' is assumed to be the globally available port of this server
		// If 'actualPort' is 0 (server not fully initialized), this might not be ideal,
		// but typically middleware runs after port is known.
		origin := fmt.Sprintf("http://localhost:%d", actualPort)
		writer.Header().Set("Access-Control-Allow-Origin", origin)
		writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")           // Common methods
		writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token") // Common headers + future auth

		// 2. Handle OPTIONS (pre-flight) requests
		if request.Method == http.MethodOptions {
			log.Printf("Middleware: Responding to OPTIONS request for %s", request.URL.Path)
			writer.WriteHeader(http.StatusOK)
			return
		}

		// 3. Token Authorization (Placeholder - globally disabled for now)
		// When 'globalAuthEnabled' is true, and 'endpointRequiresAuth' is true, token check will be performed.
		const globalAuthEnabled = false // MASTER SWITCH: Keep false to disable actual token checking logic.
		// Set to true when you're ready to implement and test token auth.

		if endpointRequiresAuth {
			log.Printf("Middleware: Endpoint %s requires auth.", request.URL.Path)
			if globalAuthEnabled {
				// --- BEGIN FUTURE AUTH LOGIC (NEEDS a.authToken to be populated in App struct) ---
				log.Printf("Middleware: Global auth is ENABLED. Performing token check for %s.", request.URL.Path)
				/*
					if a.authToken == "" { // Assuming App struct has 'authToken string'
						log.Printf("Auth Error: Auth token not configured on server for %s", request.URL.Path)
						http.Error(writer, "Internal Server Error - Auth not configured", http.StatusInternalServerError)
						return
					}

					clientToken := ""
					authHeader := request.Header.Get("Authorization")
					if authHeader != "" {
						parts := strings.Split(authHeader, " ")
						if len(parts) == 2 && strings.ToLower(parts[0]) == "bearer" {
							clientToken = parts[1]
						}
					}
					// Optionally, check for a custom token header if Authorization is empty
					if clientToken == "" {
					    clientToken = request.Header.Get("X-Auth-Token")
					}

					if clientToken == "" {
						log.Printf("Auth Warning: No token provided by client for protected endpoint %s", request.URL.Path)
						http.Error(writer, "Unauthorized - Token required", http.StatusUnauthorized)
						return
					}

					if clientToken != a.authToken {
						log.Printf("Auth Warning: Invalid token provided for %s. Client: [%s...], Expected: [%s...]",
							request.URL.Path,
							truncateTokenForLog(clientToken),
							truncateTokenForLog(a.authToken))
						http.Error(writer, "Unauthorized - Invalid token", http.StatusUnauthorized)
						return
					}
					log.Printf("Auth: Token validated successfully for %s", request.URL.Path)
				*/
				// --- END FUTURE AUTH LOGIC ---
			} else {
				log.Printf("Middleware: Global auth is DISABLED. Token check skipped for %s (even though endpoint requires it).", request.URL.Path)
			}
		} else {
			log.Printf("Middleware: Endpoint %s does not require auth.", request.URL.Path)
		}

		// 4. Call the actual handler if all checks passed (or were skipped)
		next.ServeHTTP(writer, request)
	}
}

func findFreePort() (int, error) {
	addr, err := net.ResolveTCPAddr("tcp", "localhost:0")
	if err != nil {
		return 0, err
	}
	l, err := net.ListenTCP("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// initializes and starts the HTTP server in a goroutine.
// It sets the global actualPort and serverListenAddress if successful.
// Returns an error if listener setup fails.
func (a *App) LaunchHttpServer(pythonRdyChan chan bool) error {
	targetFolderName := "wav_files"

	var audioFolderPath string

	goExecutablePath, err := os.Executable()
	if err == nil {
		goExecutableDir := filepath.Dir(goExecutablePath)
		pathAlongsideExe := filepath.Join(goExecutableDir, targetFolderName)

		if _, statErr := os.Stat(pathAlongsideExe); statErr == nil {
			// Found it next to the Go executable!
			audioFolderPath = pathAlongsideExe
		} else {
			// make the folder
			os.Mkdir(pathAlongsideExe, 0755)
			audioFolderPath = pathAlongsideExe
		}
	}

	// exePath, err := os.Executable()
	// if err != nil {
	// 	return fmt.Errorf("error getting executable path: %w", err)
	// }
	// exeDir := filepath.Dir(exePath)
	a.effectiveAudioFolderPath = audioFolderPath

	log.Printf("Audio Server: Attempting to serve .wav files from: %s", a.effectiveAudioFolderPath)

	if _, err := os.Stat(a.effectiveAudioFolderPath); os.IsNotExist(err) {
		log.Printf("Audio Server Warning: The audio folder '%s' does not exist. Please ensure it's created next to the executable.", a.effectiveAudioFolderPath)
	}

	mux := http.NewServeMux()

	// --- ENDPOINTS --- //

	// Audio files
	coreAudioHandler := http.HandlerFunc(a.audioFileEndpoint)
	mux.Handle("/", commonMiddleware(coreAudioHandler, false))

	// Ready signal
	readyHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost { // Allow GET or POST
			http.Error(w, "Method not allowed for ready signal", http.StatusMethodNotAllowed)
			log.Printf("PythonReadyHandler: Method %s blocked", r.Method)
			return
		}
		log.Println("HTTP Server: Received ready signal from Python backend.")
		if pythonRdyChan != nil {
			select {
			case pythonRdyChan <- true:
				log.Println("HTTP Server: Notified main app that Python is ready.")
			default:
				log.Println("HTTP Server Warning: Python ready channel was full or signal already sent.")
			}
		} else {
			// This case should ideally not happen if LaunchHttpServer is called correctly.
			log.Println("HTTP Server Error: pythonReadyChan (for signaling app) is nil.")
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "Go server acknowledges Python backend readiness.")
	}
	mux.Handle("/ready", commonMiddleware(http.HandlerFunc(readyHandler), false)) // false: no auth

	// Main communication endpoint
	pythonMsgHandlerFunc := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { a.msgEndpoint(w, r) })
	mux.Handle("/msg", commonMiddleware(pythonMsgHandlerFunc, false))

	// Server
	port, err := findFreePort()
	if err != nil {
		return fmt.Errorf("could not find free port: %w", err)
	}
	actualPort = port
	serverListenAddress = fmt.Sprintf("localhost:%d", actualPort)
	isServerInitialized = true
	log.Printf("🎵 Audio Server: Starting on http://%s", serverListenAddress)
	log.Printf("Audio Server: Serving .wav files from: %s", a.effectiveAudioFolderPath)

	listener, err := net.Listen("tcp", serverListenAddress)
	if err != nil {
		return fmt.Errorf("could not start HTTP server listener: %w", err)
	}
	// Start the HTTP server in a new goroutine so it doesn't block
	go func() {
		if errServe := http.Serve(listener, mux); errServe != nil && errServe != http.ErrServerClosed {
			log.Printf("ERROR: Audio Server failed: %v", errServe)
			isServerInitialized = false
			// You might want to signal this failure to the main Wails app
			// if user interaction or state change is needed.
		}
		log.Println("Audio Server: Goroutine finished.")
	}()

	return nil // Listener setup and goroutine launch successful
}

func (a *App) audioFileEndpoint(writer http.ResponseWriter, request *http.Request) {
	origin := fmt.Sprintf("http://localhost:%d", actualPort)
	writer.Header().Set("Access-Control-Allow-Origin", origin)
	writer.Header().Set("Access-Control-Allow-Methods", "GET")

	if request.Method == http.MethodOptions {
		writer.WriteHeader(http.StatusOK)
		return
	}

	if request.Method != http.MethodGet {
		http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
		log.Printf("Audio Server Warning: Non-GET request (%s) blocked for: %s", request.Method, request.URL.Path)
		return
	}

	requestedPath := filepath.Clean(request.URL.Path)
	if strings.Contains(requestedPath, "..") {
		http.Error(writer, "Invalid path", http.StatusBadRequest)
		log.Printf("Audio Server Warning: Path traversal attempt blocked for: %s", request.URL.Path)
		return
	}

	if !strings.HasSuffix(strings.ToLower(requestedPath), ".wav") {
		if requestedPath == "/" || requestedPath == "" {
			welcomeMsg := "Welcome to the internal WAV audio server."
			if isServerInitialized && serverListenAddress != "" {
				welcomeMsg += fmt.Sprintf(" Serving from http://%s (folder: %s)", serverListenAddress, a.effectiveAudioFolderPath)
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

	fullPath := filepath.Join(a.effectiveAudioFolderPath, requestedPath)
	absEffectiveAudioFolderPath, err := filepath.Abs(a.effectiveAudioFolderPath)
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
		if _, statErr := os.Stat(a.effectiveAudioFolderPath); os.IsNotExist(statErr) {
			errMsg := fmt.Sprintf("Audio folder '%s' not found. Please ensure it exists next to the executable and is named '%s'.", a.effectiveAudioFolderPath, relativeAudioFolderName)
			http.Error(writer, errMsg, http.StatusInternalServerError)
			log.Printf("Base audio folder not found: %s", a.effectiveAudioFolderPath)
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

func (a *App) msgEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed for this endpoint", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading request body", http.StatusInternalServerError)
		log.Printf("msgEndpoint: Error reading body: %v", err)
		return
	}
	defer r.Body.Close()

	var msg PythonMessage
	if err := json.Unmarshal(body, &msg); err != nil {
		http.Error(w, "Invalid JSON format", http.StatusBadRequest)
		log.Printf("msgEndpoint: Error unmarshalling main JSON: %v. Body: %s", err, string(body))
		return
	}

	log.Printf("msgEndpoint: Received type: '%s'", msg.Type)

	switch msg.Type {
	case "showToast":
		var data ToastPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil {
			http.Error(w, "Invalid payload for showToast", http.StatusBadRequest)
			log.Printf("msgEndpoint: Error unmarshalling showToast payload: %v", err)
			return
		}
		log.Printf("Go: Emitting 'showToast' event for frontend: %s (Type: %s)", data.Message, data.ToastType)
		runtime.EventsEmit(a.ctx, "showToast", data)

	case "showAlert":
		var data AlertPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil {
			http.Error(w, "Invalid payload for showAlert", http.StatusBadRequest)
			log.Printf("msgEndpoint: Error unmarshalling showAlert payload: %v", err)
			return
		}
		log.Printf("Go: Emitting 'showAlert' event for frontend: [%s] %s - %s", data.Severity, data.Title, data.Message)
		runtime.EventsEmit(a.ctx, "showAlert", data)

	case "projectData":
		var data ProjectDataPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil {
			http.Error(w, "Invalid payload for projectData", http.StatusBadRequest)
			log.Printf("msgEndpoint: Error unmarshalling projectData payload: %v", err)
			return
		}
		log.Printf("Go: Emitting 'projectData' event for frontend. Project: %s, Timeline: %s, Files: %d",
			data.ProjectName, data.Timeline.Name, len(data.Files))

		// Optional: Store this data in a.latestProjectData (with mutex protection if needed)
		// a.cacheMutex.Lock()
		// a.latestProjectData = &data
		// a.cacheMutex.Unlock()

		runtime.EventsEmit(a.ctx, "projectDataReceived", data) // Emit the full data

	default:
		log.Printf("msgEndpoint: Received unknown message type: '%s'", msg.Type)
		http.Error(w, fmt.Sprintf("Unknown message type: %s", msg.Type), http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprintln(w, "Message received by Go backend.")
}

func (a *App) GetProjectDataPayloadType() ProjectDataPayload {
	return ProjectDataPayload{
		ProjectName: "",
		Timeline: Timeline{
			Name:            "",
			FPS:             0,
			VideoTrackItems: nil,
			AudioTrackItems: nil,
		},
		Files: nil,
	}
}
