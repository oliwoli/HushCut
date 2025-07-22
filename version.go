package main

import (
	"embed"
	"encoding/json"
	"log"
)

//go:embed package.json
var content embed.FS

type PackageJSON struct {
	Version string `json:"version"`
}

var AppVersion string

func init() {
	file, err := content.ReadFile("package.json")
	if err != nil {
		log.Fatalf("Error reading embedded package.json: %v", err)
	}

	var pkg PackageJSON
	err = json.Unmarshal(file, &pkg)
	if err != nil {
		log.Fatalf("Error unmarshalling package.json: %v", err)
	}

	AppVersion = pkg.Version
}
