package main

import (
	"flag"
	"io"
	"os"

	"github.com/oliwoli/hushcut/internal/luahelperlogic"
)

func main() {
	//detachConsole() // because Windows quirk
	// Define the flags
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")
	uuidCount := flag.Int("uuid", 0, "generate N random UUIDs")
	uuidStr := flag.String("uuid-from-str", "", "string to generate a deterministic UUID from")
	luaHelper := flag.Bool("lua-helper", true, "set mode")
	flag.Parse()

	var pipeContent string
	// Check if there’s data coming in via stdin
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		// stdin is not from a terminal, so read it
		data, err := io.ReadAll(os.Stdin)
		if err == nil {
			pipeContent = string(data)
		}
	}

	if *luaHelper {
		// nothing
	}

	// Call the shared logic with pipeContent
	luahelperlogic.Start(*port, *findPort, *uuidCount, *uuidStr, pipeContent)
}
