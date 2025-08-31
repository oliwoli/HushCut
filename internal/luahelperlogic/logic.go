package luahelperlogic

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// Start runs the helper logic based on the provided parameters.
// This is the single, shared entry point for the logic.
func Start(port int, findPort bool, uuidCount int, uuidStr string) {
	// --- UUID logic ---
	if uuidCount > 0 {
		for i := 0; i < uuidCount; i++ {
			fmt.Println(uuid.New())
		}
		return
	}
	if uuidStr != "" {
		u := uuid.NewMD5(uuid.Nil, []byte(uuidStr))
		fmt.Println(u.String())
		return
	}

	// --- Server Logic ---
	if findPort {
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

	startHttpServer(port)
}

// startHttpServer is now an unexported helper function within this package.
func startHttpServer(port int) {
	osSignalChan := make(chan os.Signal, 1)
	signal.Notify(osSignalChan, syscall.SIGINT, syscall.SIGTERM)
	httpShutdownChan := make(chan struct{})

	mux := http.NewServeMux()
	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}

	// ... (All your mux.HandleFunc calls for /command, /shutdown, etc. go here) ...
	// This is the exact same logic as before.

	go func() {
		log.Printf("Starting lua-helper server on port %d", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("could not listen on %s: %v\n", server.Addr, err)
		}
	}()

	select {
	case <-osSignalChan:
		log.Println("Shutdown signal received from OS.")
	case <-httpShutdownChan:
		log.Println("Shutdown signal received from HTTP /shutdown endpoint.")
	}

	log.Println("Initiating graceful shutdown...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown failed: %v", err)
	}
	log.Println("Server exited properly")
}
