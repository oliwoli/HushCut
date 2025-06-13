// httpserver.go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const relativeAudioFolderName = "wav_files" // User-defined relative folder

var (
	serverListenAddress string // Stores "localhost:PORT" for display or "IP:PORT" from listener.Addr()
	actualPort          int    // port for audio server + messages from python backend to go
	isServerInitialized bool   // Flag to indicate if server init (port assignment) was successful
)

type PythonMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"` // Delay parsing payload until type is known
}

type TaskUpdatePayload struct {
    Message  string  `json:"message"`
	TaskType string  `json:"tasktype,omitempty"`
    Progress float64 `json:"progress,omitempty"` // Optional progress percentage (0.0 to 1.0)
}

type ToastPayload struct {
	Message   string `json:"message"`
	ToastType string `json:"toastType,omitempty"` // e.g., "info", "success", "warning", "error"
}

type AlertPayload struct {
	Title    string `json:"title"`
	Message  string `json:"message"`
	Severity string `json:"severity"` // e.g., "info", "warning", "error"
}

type ClipInfo struct {
	Name        string  `json:"name"`
	FilePath    string  `json:"filePath"` // Absolute path to the audio file for Go to serve
	TimelineIn  float64 `json:"timelineIn"`
	TimelineOut float64 `json:"timelineOut"`
	SourceIn    float64 `json:"sourceIn"`
	SourceOut   float64 `json:"sourceOut"`
}

type PythonCommandResponse struct {
	Status  string      `json:"status"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
	// Alert
	ShouldShowAlert bool   `json:"shouldShowAlert,omitempty"`
	AlertTitle      string `json:"alertTitle,omitempty"`
	AlertMessage    string `json:"alertMessage,omitempty"`
	AlertSeverity   string `json:"alertSeverity,omitempty"` // "info", "warning", "error"

	AlertIssued bool `json:"alertIssued,omitempty"`
}

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

	// Clip rendering endpoint
	mux.HandleFunc("/render_clip", commonMiddleware(http.HandlerFunc(a.handleRenderClip), false))

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
	writer.Header().Set("Accept-Ranges", "bytes") // Good for media seeking
	http.ServeFile(writer, request, fullPath)
	log.Printf("Audio Server Served: %s (Client: %s)", fullPath, request.RemoteAddr)
}

// (Assuming a.effectiveAudioFolderPath is correctly set up as in your original code)

func (a *App) handleRenderClip(w http.ResponseWriter, r *http.Request) {
	// Allow GET and HEAD. HEAD is useful for players to check content length/type without downloading.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		log.Printf("RenderClip: Method %s blocked for: %s", r.Method, r.URL.Path)
		return
	}

	query := r.URL.Query()
	fileName := query.Get("file")
	startStr := query.Get("start")
	endStr := query.Get("end")

	if fileName == "" || startStr == "" || endStr == "" {
		http.Error(w, "Missing required query parameters: file, start, end", http.StatusBadRequest)
		log.Printf("RenderClip: Missing parameters. File: '%s', Start: '%s', End: '%s'", fileName, startStr, endStr)
		return
	}

	startSeconds, errStart := strconv.ParseFloat(startStr, 64)
	endSeconds, errEnd := strconv.ParseFloat(endStr, 64)

	if errStart != nil || errEnd != nil || startSeconds < 0 || endSeconds <= startSeconds {
		http.Error(w, "Invalid start or end time parameters", http.StatusBadRequest)
		log.Printf("RenderClip: Invalid time parameters. Start: '%s' (err: %v), End: '%s' (err: %v)", startStr, errStart, endStr, errEnd)
		return
	}

	cleanFileName := filepath.Base(fileName)
	if cleanFileName != fileName || strings.Contains(fileName, "..") || strings.ContainsAny(fileName, "/\\") {
		http.Error(w, "Invalid file name parameter", http.StatusBadRequest)
		log.Printf("RenderClip: Invalid file name (potential traversal): '%s'", fileName)
		return
	}

	originalFilePath := filepath.Join(a.effectiveAudioFolderPath, cleanFileName)

	if _, err := os.Stat(originalFilePath); os.IsNotExist(err) {
		http.NotFound(w, r)
		log.Printf("RenderClip: Original source file not found: %s", originalFilePath)
		return
	}

	log.Printf("RenderClip: Processing request for %s, segment %f to %f seconds. Range: %s",
		originalFilePath, startSeconds, endSeconds, r.Header.Get("Range"))

	cmd := exec.Command("ffmpeg",
		"-i", originalFilePath,
		"-ss", fmt.Sprintf("%f", startSeconds),
		"-to", fmt.Sprintf("%f", endSeconds),
		"-c", "copy",
		"-f", "wav",
		"-vn",
		"pipe:1",
	)

	ffmpegOutput, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("RenderClip: Error creating StdoutPipe for ffmpeg: %v", err)
		http.Error(w, "Internal server error (ffmpeg pipe)", http.StatusInternalServerError)
		return
	}

	ffmpegErrOutput, err := cmd.StderrPipe()
	if err != nil {
		log.Printf("RenderClip: Error creating StderrPipe for ffmpeg: %v", err)
		// Continue, but we might not get detailed ffmpeg errors
	}

	if err := cmd.Start(); err != nil {
		log.Printf("RenderClip: Error starting ffmpeg for %s: %v", originalFilePath, err)
		http.Error(w, "Internal server error (ffmpeg start)", http.StatusInternalServerError)
		return
	}

	var ffmpegErrBuffer bytes.Buffer
	if ffmpegErrOutput != nil {
		go func() {
			_, copyErr := io.Copy(&ffmpegErrBuffer, ffmpegErrOutput)
			if copyErr != nil {
				log.Printf("RenderClip: Error copying ffmpeg stderr: %v", copyErr)
			}
		}()
	}

	// Buffer the entire ffmpeg output for this segment
	var audioData bytes.Buffer
	bytesCopied, copyErr := io.Copy(&audioData, ffmpegOutput)

	waitErr := cmd.Wait()

	if copyErr != nil {
		log.Printf("RenderClip: Error piping ffmpeg output to internal buffer for %s: %v. Bytes copied: %d. FFMPEG Stderr: %s",
			originalFilePath, copyErr, bytesCopied, ffmpegErrBuffer.String())
		// Avoid writing partial content if pipe broke
		if !strings.Contains(copyErr.Error(), "read/write on closed pipe") && // Common if client disconnects
			!strings.Contains(copyErr.Error(), "broken pipe") { // Also common
			http.Error(w, "Internal server error (ffmpeg stream copy)", http.StatusInternalServerError)
			return
		}
		log.Printf("RenderClip: Continuing despite pipe error during copy, likely client disconnect or ffmpeg finished early. Copied %d bytes.", bytesCopied)
	}

	if waitErr != nil {
		log.Printf("RenderClip: ffmpeg command finished with error for %s: %v. Stderr: %s. Bytes copied to buffer: %d",
			originalFilePath, waitErr, ffmpegErrBuffer.String(), audioData.Len())
		if audioData.Len() == 0 { // Or some threshold if partial WAVs could be useful
			http.Error(w, "Internal server error (ffmpeg execution)", http.StatusInternalServerError)
			return
		}
		log.Printf("RenderClip: Warning - ffmpeg exited with error, but some data (%d bytes) was captured. Attempting to serve.", audioData.Len())
	}

	if audioData.Len() == 0 && bytesCopied == 0 && waitErr == nil && copyErr == nil {
		log.Printf("RenderClip: ffmpeg produced no output for %s (segment %f-%f). Stderr: %s", originalFilePath, startSeconds, endSeconds, ffmpegErrBuffer.String())
		// This could happen if the segment is empty or ffmpeg has an issue not reported as an exit error.
		// Send a custom error or an empty WAV, or just 204 No Content.
		// For now, let's treat as not found or bad request.
		http.Error(w, "No content generated for the requested segment.", http.StatusNotFound) // Or http.StatusInternalServerError
		return
	}

	log.Printf("RenderClip: Successfully buffered %d bytes for %s (segment %f-%f). Now serving with http.ServeContent.",
		audioData.Len(), originalFilePath, startSeconds, endSeconds)

	// Create an io.ReadSeeker from the buffered data
	audioDataReader := bytes.NewReader(audioData.Bytes())

	// Set headers that http.ServeContent might use or that are good practice
	w.Header().Set("Content-Type", "audio/wav")
	// Accept-Ranges will be set by ServeContent if the seeker supports it, which bytes.Reader does.
	w.Header().Set("Accept-Ranges", "bytes") // Not strictly needed here, ServeContent does it.

	serveName := fmt.Sprintf("rendered_clip_%s_%.2f_%.2f.wav", cleanFileName, startSeconds, endSeconds)

	// Modification time: For dynamic content, time.Now() is okay.
	// If the content was cached and had a fixed generation time, you'd use that.
	// Using a fixed time (e.g., based on original file's modtime if transformation is deterministic)
	// can improve client-side caching if the same segment is requested again.
	modTime := time.Now()

	http.ServeContent(w, r, serveName, modTime, audioDataReader)
}

func (a *App) msgEndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Only POST method is allowed", http.StatusMethodNotAllowed)
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
		http.Error(w, "Invalid JSON format for PythonMessage", http.StatusBadRequest)
		log.Printf("msgEndpoint: Error unmarshalling PythonMessage: %v. Body: %s", err, string(body))
		return
	}

	log.Printf("msgEndpoint: Received type: '%s'", msg.Type)
	taskID := r.URL.Query().Get("task_id")

	if msg.Type == "taskUpdate" {
        if taskID == "" {
            http.Error(w, "'taskUpdate' requires a task_id", http.StatusBadRequest)
            return
        }

        var updateData TaskUpdatePayload
        if err := json.Unmarshal(msg.Payload, &updateData); err != nil {
            http.Error(w, "Invalid payload for 'taskUpdate'", http.StatusBadRequest)
            log.Printf("msgEndpoint: Error unmarshalling taskUpdate payload: %v", err)
            return
        }

        // Emit an event to the frontend with the progress update.
        // The frontend will listen for "taskProgressUpdate".
        runtime.EventsEmit(a.ctx, "taskProgressUpdate", map[string]interface{}{
            "taskID":   taskID,
            "message":  updateData.Message,
            "progress": updateData.Progress,
        })

        w.WriteHeader(http.StatusOK)
        fmt.Fprintln(w, "Task update received.")
        return // IMPORTANT: We are done. We do not touch the pendingTasks channel.
    }

	// --- New Primary Handler for Task-Related Responses from Python ---
	if msg.Type == "taskResult" {
		if taskID == "" {
			log.Printf("msgEndpoint: Received 'taskResult' without task_id. Ignoring for task channel.")
			// Optionally, if it has ShouldShowAlert, you could emit a generic alert, but it's cleaner if Python always includes task_id for these.
			http.Error(w, "'taskResult' requires a task_id", http.StatusBadRequest)
			return
		}

		var taskData PythonCommandResponse // This struct now includes ShouldShowAlert etc.
		if err := json.Unmarshal(msg.Payload, &taskData); err != nil {
			http.Error(w, "Invalid payload for 'taskResult'", http.StatusBadRequest)
			log.Printf("msgEndpoint: Error unmarshalling taskResult payload: %v. Body: %s", err, string(msg.Payload))
			return
		}
		log.Printf("msgEndpoint: Received 'taskResult' for taskID '%s'. Status: '%s', ShouldShowAlert: %t",
			taskID, taskData.Status, taskData.ShouldShowAlert)

		a.pendingMu.Lock()
		respCh, ok := a.pendingTasks[taskID]
		a.pendingMu.Unlock()

		if ok {
			// Send the entire taskData (which includes Python's alert *request*) to SyncWithDavinci
			select {
			case respCh <- taskData:
				log.Printf("msgEndpoint: Successfully sent taskData to SyncWithDavinci channel for task %s", taskID)
			default:
				log.Printf("msgEndpoint: WARNING - Could not send to respCh for task %s. Channel full/listener gone.", taskID)
				// If SyncWithDavinci is gone but Python wanted an alert, we *could* emit it here as a fallback.
				// However, this implies SyncWithDavinci might have timed out or errored earlier.
				if taskData.ShouldShowAlert {
					log.Printf("msgEndpoint: SyncWithDavinci listener gone for task %s, but Python requested alert. Emitting globally.", taskID)
					runtime.EventsEmit(a.ctx, "showAlert", map[string]interface{}{
						"title":    taskData.AlertTitle,
						"message":  taskData.AlertMessage,
						"severity": taskData.AlertSeverity,
					})
				}
			}
		} else {
			log.Printf("msgEndpoint: Warning - Received 'taskResult' for taskID '%s', but no pending task found.", taskID)
			// Similar to above, if no pending task, but Python wanted an alert for this orphaned task_id.
			if taskData.ShouldShowAlert {
				log.Printf("msgEndpoint: No pending task for %s, but Python requested alert. Emitting globally.", taskID)
				runtime.EventsEmit(a.ctx, "showAlert", map[string]interface{}{
					"title":    taskData.AlertTitle,
					"message":  taskData.AlertMessage,
					"severity": taskData.AlertSeverity,
				})
			}
		}
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "Task result processed.")
		return // Handled
	}

	// --- Existing handlers for generic, non-task-specific messages ---
	switch msg.Type {
	case "showToast":
		var data ToastPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil { /* ... error handling ... */
			return
		}
		runtime.EventsEmit(a.ctx, "showToast", data)

	case "showAlert": // This is now for alerts NOT related to a SyncWithDavinci task
		if taskID != "" {
			log.Printf("msgEndpoint: 'showAlert' with task_id '%s' received. This is likely an old Python flow. Emitting alert globally but not notifying task channel.", taskID)
		}
		var data AlertPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil { /* ... error handling ... */
			return
		}
		runtime.EventsEmit(a.ctx, "showAlert", data) // Global alert

	case "projectData": // This is now for generic data pushes NOT related to a SyncWithDavinci task completion
		if taskID != "" {
			log.Printf("msgEndpoint: 'projectData' with task_id '%s' received. If this is a task response, Python should use 'taskResult' type.", taskID)
			// If you need to temporarily support old Python sending projectData as task response:
			// ... (handle by trying to parse as ProjectDataPayload and sending a minimal PythonCommandResponse to channel)
			// But it's better to update Python.
		}
		var data ProjectDataPayload
		if err := json.Unmarshal(msg.Payload, &data); err != nil { /* ... error handling ... */
			return
		}
		runtime.EventsEmit(a.ctx, "projectDataReceived", data) // Generic data update

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

func (a *App) SendCommandToPython(commandName string, params map[string]interface{}) (*PythonCommandResponse, error) {
	if !a.pythonReady || a.pythonCommandPort == 0 { // Check general pythonReady flag
		return nil, fmt.Errorf("python backend or its command server is not ready (port: %d, ready: %v)", a.pythonCommandPort, a.pythonReady)
	}

	url := fmt.Sprintf("http://localhost:%d/command", a.pythonCommandPort)
	commandPayload := map[string]interface{}{
		"command": commandName,
		"params":  params, // Can be nil if no params
	}
	if params == nil {
		commandPayload["params"] = make(map[string]interface{}) // Ensure params is at least an empty object
	}

	jsonBody, err := json.Marshal(commandPayload)
	if err != nil {
		return nil, fmt.Errorf("error marshalling Python command: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("error creating request for Python command: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// --- FUTURE: Add Authorization Token to call Python's command server ---
	// globalEnableAuthToPython := false // This would be a config
	// if globalEnableAuthToPython && a.sharedSecretForPython != "" {
	//  req.Header.Set("Authorization", "Bearer " + a.sharedSecretForPython)
	// }
	// --- END FUTURE ---

	log.Printf("Go: Sending command '%s' to Python at %s with payload: %s", commandName, url, string(jsonBody))

	client := &http.Client{Timeout: 20 * time.Second} // Adjust timeout as needed
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("- %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%w", err)
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("Go: Python command server responded with status %d for command '%s'. Body: %s", resp.StatusCode, commandName, string(responseBody))
		// Attempt to parse Python's structured error
		var errResp PythonCommandResponse
		if json.Unmarshal(responseBody, &errResp) == nil && errResp.Message != "" {
			return &errResp, fmt.Errorf("python command '%s' failed with status %d: %s", commandName, resp.StatusCode, errResp.Message)
		}
		return nil, fmt.Errorf("python command '%s' failed with status %d: %s", commandName, resp.StatusCode, string(responseBody))
	}

	var pyResp PythonCommandResponse
	if err := json.Unmarshal(responseBody, &pyResp); err != nil {
		return nil, fmt.Errorf("error unmarshalling Python response for command '%s': %w. Body: %s", commandName, err, string(responseBody))
	}

	log.Printf("Go: Response from Python for command '%s': Status: '%s', Message: '%s'", commandName, pyResp.Status, pyResp.Message)
	return &pyResp, nil
}

func (a *App) SyncWithDavinci() (*PythonCommandResponse, error) { // Use your actual PythonCommandResponse type
	if !a.pythonReady {
		// This error will be caught by JS, and a toast will be shown. No AlertIssued flag needed.
		return nil, fmt.Errorf("python backend not ready")
	}

	taskID := uuid.NewString()
	// Use the correct type for PythonCommandResponse, e.g., main.PythonCommandResponse
	respCh := make(chan PythonCommandResponse, 1)

	a.pendingMu.Lock()
	a.pendingTasks[taskID] = respCh
	a.pendingMu.Unlock()

	// Cleanup deferred to ensure it runs
	defer func() {
		a.pendingMu.Lock()
		delete(a.pendingTasks, taskID)
		a.pendingMu.Unlock()
		log.Printf("Go: Cleaned up task %s", taskID)
	}()

	params := map[string]interface{}{
		"taskId": taskID,
	}

	pyAckResp, err := a.SendCommandToPython("sync", params) // This is the initial ACK from Python
	if err != nil {
		return nil, fmt.Errorf("failed to send command to python: %w", err)
	}
	if pyAckResp.Status != "success" {
		return nil, fmt.Errorf("python command acknowledgement error: %s", pyAckResp.Message)
	}

	log.Printf("Go: Waiting for final Python response for task %s...", taskID)
	finalResponse := <-respCh // Wait for Python's actual processing response
	log.Printf("Go: Received final Python response for task %s", taskID)

	if finalResponse.ShouldShowAlert {
		log.Printf("Go: Python requested an alert. Title: '%s', Message: '%s', Severity: '%s'",
			finalResponse.AlertTitle, finalResponse.AlertMessage, finalResponse.AlertSeverity)

		runtime.EventsEmit(a.ctx, "showAlert", map[string]interface{}{
			"title":    finalResponse.AlertTitle,
			"message":  finalResponse.AlertMessage,
			"severity": finalResponse.AlertSeverity,
		})

		finalResponse.AlertIssued = true

		if finalResponse.Status == "" || finalResponse.Status == "success" { // If Python didn't explicitly set status to error
			finalResponse.Status = "error" // Default to error if an alert is flagged
		}
		if finalResponse.Message == "" && finalResponse.AlertMessage != "" {
			finalResponse.Message = finalResponse.AlertMessage
		}
	}

	if finalResponse.Status != "success" {
		log.Printf("Go: Python task %s reported status '%s'. AlertIssued: %t. Message: %s",
			taskID, finalResponse.Status, finalResponse.AlertIssued, finalResponse.Message)
		return &finalResponse, nil
	}

	// Python reported success, and no alert was needed (or it was handled)
	log.Printf("Go: Python task %s reported success. Message: %s", taskID, finalResponse.Message)
	return &finalResponse, nil // finalResponse.AlertIssued will be false if no alert was processed
}

func (a *App) MakeFinalTimeline(projectData *ProjectDataPayload) (*PythonCommandResponse, error) {
    if !a.pythonReady {
        return nil, fmt.Errorf("python backend not ready")
    }
	runtime.EventsEmit(a.ctx, "showFinalTimelineProgress")

    // 1. Adopt the async task pattern
    taskID := uuid.NewString()
    respCh := make(chan PythonCommandResponse, 1)

    a.pendingMu.Lock()
    a.pendingTasks[taskID] = respCh
    a.pendingMu.Unlock()

    defer func() {
        a.pendingMu.Lock()
        delete(a.pendingTasks, taskID)
        a.pendingMu.Unlock()
        log.Printf("Go: Cleaned up task %s", taskID)
    }()
    
    // The frontend can now listen for "taskProgressUpdate" events with this taskID
    log.Printf("Go: Starting task 'makeFinalTimeline' with ID: %s", taskID)

    // 2. Add taskId to the parameters sent to Python
    params := map[string]interface{}{
        "taskId":      taskID,
        "projectData": projectData,
    }

    // 3. Send the command and just check the acknowledgement
    pyAckResp, err := a.SendCommandToPython("makeFinalTimeline", params)
    if err != nil {
        return nil, fmt.Errorf("failed to send 'makeFinalTimeline' command: %w", err)
    }
    if pyAckResp.Status != "success" {
        return nil, fmt.Errorf("python 'makeFinalTimeline' ack error: %s", pyAckResp.Message)
    }

    log.Printf("Go: Waiting for final timeline result for task %s...", taskID)

    // 4. Wait for the final result from the channel
    finalResponse := <-respCh
    log.Printf("Go: Received final timeline result for task %s", taskID)

    // 5. Process the final response (handle alerts, errors, etc.)
    if finalResponse.ShouldShowAlert {
        runtime.EventsEmit(a.ctx, "showAlert", map[string]interface{}{
            "title":    finalResponse.AlertTitle, "message":  finalResponse.AlertMessage, "severity": finalResponse.AlertSeverity,
        })
        finalResponse.AlertIssued = true
        if finalResponse.Status != "error" { finalResponse.Status = "error" }
        if finalResponse.Message == "" { finalResponse.Message = finalResponse.AlertMessage }
    }
    
    // Return the full response object, which is more flexible than just a string
    if finalResponse.Status != "success" {
        // We return the response object so the frontend can see the message, even on error.
        // The second return value (error) is nil because the *communication* was successful.
        // The frontend should check the Status field of the returned object.
        return &finalResponse, nil
    }
	runtime.EventsEmit(a.ctx, "finished")
    return &finalResponse, nil
}
