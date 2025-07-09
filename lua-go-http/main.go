package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")
	flag.Parse()

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
