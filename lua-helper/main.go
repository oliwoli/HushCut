package main

import (
	"flag"
	"log"

	"github.com/oliwoli/hushcut/internal/luahelperlogic"
)

func main() {
	// Define the flags
	port := flag.Int("port", 8080, "port to listen on")
	findPort := flag.Bool("find-port", false, "find a free port and exit")
	uuidCount := flag.Int("uuid", 0, "generate N random UUIDs")
	uuidStr := flag.String("uuid-from-str", "", "string to generate a deterministic UUID from")
	luaHelper := flag.Bool("lua-helper", true, "set mode")
	flag.Parse()

	if *luaHelper {
		log.Println("starting lua helper") //useless print just to use the variable
	}

	// Call the shared logic
	luahelperlogic.Start(*port, *findPort, *uuidCount, *uuidStr)
}
