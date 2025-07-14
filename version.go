package main

import (
	"encoding/json"
	"log"
	"os"
)

type PackageJSON struct {
	Version string `json:"version"`
}

var AppVersion string

func init() {
	content, err := os.ReadFile("package.json")
	if err != nil {
		log.Fatalf("Error reading package.json: %v", err)
	}

	var pkg PackageJSON
	err = json.Unmarshal(content, &pkg)
	if err != nil {
		log.Fatalf("Error unmarshalling package.json: %v", err)
	}

	AppVersion = pkg.Version
}
