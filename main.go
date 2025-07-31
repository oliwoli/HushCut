package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

// SilencePeriod (from previous step)
type SilencePeriod struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// CacheKey defines the unique identifier for a silence detection request.
type CacheKey struct {
	FilePath                  string  `json:"filePath"` // Using struct tags for potential future use, not strictly necessary for map key
	LoudnessThreshold         float64 `json:"loudnessThreshold"`
	MinSilenceDurationSeconds float64 `json:"minSilenceDurationSeconds"`
	PaddingLeftSeconds        float64 `json:"paddingLeftSeconds"`
	PaddingRightSeconds       float64 `json:"paddingRightSeconds"`
	MinContentDuration        float64 `json:"minContentDuration"`
	ClipStartSeconds          float64 `json:"clipStartSeconds"`
	ClipEndSeconds            float64 `json:"clipEndSeconds"`
}

type WaveformCacheKey struct {
	FilePath         string // It's advisable to use an absolute/canonical path here if effectiveAudioFolderPath can change
	SamplesPerPixel  int
	PeakType         string // "logarithmic" or "linear"
	MinDb            float64
	MaxDb            float64 // maxDb is used by ProcessWavToLogarithmicPeaks
	ClipStartSeconds float64
	ClipEndSeconds   float64
}

type FileLoader struct {
	http.Handler
}

func NewFileLoader() *FileLoader {
	return &FileLoader{}
}

func (h *FileLoader) ServeHTTP(res http.ResponseWriter, req *http.Request) {
	var err error
	requestedFilename := strings.TrimPrefix(req.URL.Path, "/")
	println("Requesting file:", requestedFilename)
	fileData, err := os.ReadFile(requestedFilename)
	if err != nil {
		res.WriteHeader(http.StatusBadRequest)
		res.Write([]byte(fmt.Sprintf("Could not load file %s", requestedFilename)))
	}

	res.Write(fileData)
}

//go:embed build/appicon.png
var icon []byte

// various functionalities which are hard to implement in lua without 3rd party packages directly, therefore lua starts HushCut in this mode to get certain functions
// includes uuid, deterministic uuid by string, http server
func startInLuaHelperMode(port *int, findPort *bool, uuidCount *int, uuidStr *string) {
	// --- UUID logic ---
	if *uuidCount > 0 {
		for i := 0; i < *uuidCount; i++ {
			fmt.Println(uuid.New())
		}
		return
	}

	if *uuidStr != "" {
		// Treat the entire string as a single input for UUID generation.
		s := *uuidStr
		// Generate a UUID using MD5 hash of the input string.
		// This creates a deterministic UUID based on the content of the string.
		u := uuid.NewMD5(uuid.Nil, []byte(s))
		uuidStr := u.String()
		fmt.Println(uuidStr)
		return
	}
	// ------------------

	if *findPort {
		addr, err := net.ResolveTCPAddr("tcp", "localhost:0")
		if err != nil {
			log.Fatalf("could not resolve tcp addr: %v", err)
		}

		l, err := net.ListenTCP("tcp", addr)
		if err != nil {
			log.Fatalf("could not listen on tcp addr: %v", err)
		}
		defer l.Close()
		fmt.Println(l.Addr().(*net.TCPAddr).Port)
		return
	}

	// Channel for listening to OS signals (like Ctrl+C)
	osSignalChan := make(chan os.Signal, 1)
	signal.Notify(osSignalChan, syscall.SIGINT, syscall.SIGTERM)

	// Channel to listen for the shutdown request from our HTTP handler
	httpShutdownChan := make(chan struct{})

	mux := http.NewServeMux()
	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", *port),
		Handler: mux,
	}

	// Root handler to print requests
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		log.Println("---- Incoming Request ----")
		log.Printf("%s %s %s", r.Method, r.URL.Path, r.Proto)

		for name, values := range r.Header {
			for _, value := range values {
				log.Printf("Header: %s: %s", name, value)
			}
		}

		if r.Body != nil {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				log.Printf("Error reading body: %v", err)
			} else if len(body) > 0 {
				log.Printf("Body: %s", string(body))
			}
		}

		fmt.Fprintln(w, "Request logged.")
	})

	mux.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		// Read and store the body once
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Failed to read request body", http.StatusBadRequest)
			return
		}

		var payload struct {
			Command string                 `json:"command"`
			Params  map[string]interface{} `json:"params"`
		}
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			http.Error(w, "Invalid JSON", http.StatusBadRequest)
			return
		}

		log.Printf("Received command: %s", payload.Command)

		switch payload.Command {
		case "sync":
			// Log the request metadata
			log.Printf("%s %s %s", r.Method, r.URL.Path, r.Proto)
			for name, values := range r.Header {
				for _, value := range values {
					log.Printf("Header: %s: %s", name, value)
				}
			}
			if len(bodyBytes) > 0 {
				log.Printf("Body: %s", string(bodyBytes))
			}

			// Send response
			response := map[string]string{
				"status":  "success",
				"message": "Sync command received.",
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(response)

		case "setPlayhead":
			// Log the request metadata
			log.Printf("%s %s %s", r.Method, r.URL.Path, r.Proto)
			for name, values := range r.Header {
				for _, value := range values {
					log.Printf("Header: %s: %s", name, value)
				}
			}
			if len(bodyBytes) > 0 {
				log.Printf("Body: %s", string(bodyBytes))
			}

			// send response
			response := map[string]string{
				"status":  "success",
				"message": "Set playhead command received.",
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(response)

		case "makeFinalTimeline":
			// Log the request metadata
			log.Printf("%s %s %s", r.Method, r.URL.Path, r.Proto)
			for name, values := range r.Header {
				for _, value := range values {
					log.Printf("Header: %s: %s", name, value)
				}
			}
			if len(bodyBytes) > 0 {
				log.Printf("Body: %s", string(bodyBytes))
			}

			// send response
			response := map[string]string{
				"status":  "success",
				"message": "Set playhead command received.",
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(response)

		default:
			// Unsupported command
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"status":  "error",
				"message": fmt.Sprintf("Unknown command: %s", payload.Command),
			})
		}
	})

	// The shutdown handler now only sends a signal
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		log.Println("Shutdown requested from HTTP client")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Server shutting down..."))

		// **THE FIX**: Signal the main goroutine to shutdown by closing the channel.
		close(httpShutdownChan)
	})

	// Start the server in a goroutine
	go func() {
		log.Printf("Starting server on port %d", *port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("could not listen on %s: %v\n", server.Addr, err)
		}
	}()

	// **THE FIX**: Block here until a signal is received from either source.
	select {
	case <-osSignalChan:
		log.Println("Shutdown signal received from OS.")
	case <-httpShutdownChan:
		log.Println("Shutdown signal received from HTTP /shutdown endpoint.")
	}

	log.Println("Initiating graceful shutdown...")

	// Now, perform the graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown failed: %v", err)
	}

	log.Println("Server exited properly")
	// The main function will now exit, terminating the app.
}

func main() {
	luaMode := flag.Bool("lua-helper", false, "start headless in lua-helper mode")
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")

	uuidCount := flag.Int("uuid", 0, "generate N random UUIDs")
	uuidStr := flag.String("uuid-from-str", "", "comma-separated list of strings to generate deterministic UUIDs")

	pythonPort := flag.Int("python-port", 0, "port python should listen on")

	flag.Parse()
	if *luaMode {
		startInLuaHelperMode(
			port,
			findPort,
			uuidCount,
			uuidStr,
		)
		return
	}
	fmt.Print("Starting in normal mode... ?")

	// Create an instance of the app structure
	app := NewApp()
	if *pythonPort != 0 {
		app.pythonCommandPort = *pythonPort
	}
	tokenFromStdIn, stdinErr := io.ReadAll(os.Stdin)
	if stdinErr != nil {
		fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", stdinErr)
	}

	fmt.Printf("Received token from stdin: %s\n", string(tokenFromStdIn))
	app.authToken = strings.TrimSpace(string(tokenFromStdIn))

	// Check for WAILS_PYTHON_PORT environment variable (used when launched by Python in dev mode)
	if pythonPortStr := os.Getenv("WAILS_PYTHON_PORT"); pythonPortStr != "" {
		if p, err := strconv.Atoi(pythonPortStr); err == nil {
			app.pythonCommandPort = p
			log.Printf("Go App: Received Python port from environment variable: %d", app.pythonCommandPort)
		} else {
			log.Printf("Go App: Could not parse WAILS_PYTHON_PORT environment variable: %v", err)
		}
	}

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "HushCut",
		Width:     1024,
		Height:    801,
		MinWidth:  500,
		MinHeight: 550,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: NewFileLoader(),
		},
		BackgroundColour: &options.RGBA{R: 40, G: 40, B: 46, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
		LogLevel:    logger.INFO,
		AlwaysOnTop: true,
		Frameless:   true,
		Linux: &linux.Options{
			Icon:                icon,
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyNever,
			ProgramName:         "HushCut",
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
