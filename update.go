package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type AlertContent struct {
	Title       string `json:"title"`
	Message     string `json:"message"`
	ButtonLabel string `json:"button_label"`
	ButtonURL   string `json:"button_url"`
}

type GithubAsset struct {
	BrowserDownloadUrl string `json:"browser_download_url"`
	Name               string `json:"name"`
	Size               int    `json:"size"`
	ContentType        string `json:"content_type"`
	Digest             string `json:"digest"`
}

type GithubData struct {
	TagName string        `json:"tag_name"`
	HtmlUrl string        `json:"html_url"`
	Assets  []GithubAsset `json:"assets"`
	Body    string        `json:"body"`
}

type UpdateResponseV1 struct {
	SchemaVersion int          `json:"schema_version"`
	LatestVersion string       `json:"latest_version"`
	URL           string       `json:"url"`
	UpdateLabel   string       `json:"update_label"`
	ShowAlert     bool         `json:"show_alert"`
	AlertContent  AlertContent `json:"alert_content"`
	AlertSeverity string       `json:"alert_severity"`
	GithubData    GithubData   `json:"github_data"`
	Signature     string       `json:"signature"`
}

func (a *App) checkForUpdate(currentVersion string) {
	schemaVersion := "1"
	updateURL := "https://api.hushcut.app/update?v=" + url.QueryEscape(currentVersion) + "&schemaVersion=" + schemaVersion
	if a.testApi {
		updateURL = "http://localhost:8080/update?v=" + url.QueryEscape(currentVersion) + "&schemaVersion=" + schemaVersion
	}

	client := &http.Client{Timeout: 10 * time.Second}

	var resp *http.Response
	var err error

	maxRetries := 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		resp, err = client.Get(updateURL)
		if err == nil {
			break
		}
		log.Printf("Update check attempt %d failed: %v", attempt, err)
		time.Sleep(time.Duration(attempt) * time.Second) // simple backoff
	}

	if err != nil {
		log.Printf("Update check ultimately failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		log.Println("App is up to date")
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("Unexpected update response: %d", resp.StatusCode)
		return
	}

	var updateResp UpdateResponseV1
	if err := json.NewDecoder(resp.Body).Decode(&updateResp); err != nil {
		log.Printf("Error decoding update response: %v", err)
		return
	}

	a.updateInfo = &updateResp
	log.Printf("Update available: %+v", updateResp)
	runtime.EventsEmit(a.ctx, "updateAvailable", updateResp)
}

func (a *App) GetUpdateInfo() *UpdateResponseV1 {
	runtime.EventsEmit(a.ctx, "updateAvailable", a.updateInfo)
	return a.updateInfo

}
