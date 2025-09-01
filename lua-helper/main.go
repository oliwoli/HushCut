package main

import (
	"flag"

	"github.com/oliwoli/hushcut/internal/luahelperlogic"
)

func main() {
	// Define the flags
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")
	uuidCount := flag.Int("uuid", 0, "generate N random UUIDs")
	uuidStr := flag.String("uuid-from-str", "", "string to generate a deterministic UUID from")
	flag.Parse()

	// Call the shared logic
	luahelperlogic.Start(*port, *findPort, *uuidCount, *uuidStr)
}
