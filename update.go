package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
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

type githubReleaseResponse struct {
	TagName string `json:"tag_name"`
	HtmlUrl string `json:"html_url"`
	Body    string `json:"body"`
	Assets  []struct {
		BrowserDownloadUrl string `json:"browser_download_url"`
		Name               string `json:"name"`
		Size               int    `json:"size"`
		ContentType        string `json:"content_type"`
	} `json:"assets"`
}

// parseSemver splits a version string into numeric parts and optional prerelease suffix.
// Examples:
// "v0.4.0" -> [0, 4, 0], ""
// "0.4.1-beta.1" -> [0, 4, 1], "beta.1"
func parseSemver(v string) ([]int, string) {
	v = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(v), "v"), "V")
	pre := ""
	if idx := strings.Index(v, "-"); idx != -1 {
		pre = v[idx+1:]
		v = v[:idx]
	}

	parts := strings.Split(v, ".")
	nums := make([]int, 3)
	for i := 0; i < len(parts) && i < 3; i++ {
		if n, err := strconv.Atoi(parts[i]); err == nil {
			nums[i] = n
		}
	}
	return nums, pre
}

// isNewerVersion returns true if latest is strictly newer than current.
func isNewerVersion(currentVersion, latestVersion string) bool {
	currNums, currPre := parseSemver(currentVersion)
	latestNums, latestPre := parseSemver(latestVersion)

	for i := 0; i < 3; i++ {
		if latestNums[i] > currNums[i] {
			return true
		}
		if latestNums[i] < currNums[i] {
			return false
		}
	}

	// Core versions are equal. Check prerelease tags.
	// A stable release (empty pre) is newer than a prerelease of the same version.
	if currPre != "" && latestPre == "" {
		return true
	}
	if currPre == "" && latestPre != "" {
		return false
	}
	if currPre != "" && latestPre != "" {
		return latestPre > currPre
	}

	return false
}

func (a *App) checkForUpdate(currentVersion string) {
	updateURL := "https://api.github.com/repos/oliwoli/HushCut/releases/latest"
	if a.testApi {
		updateURL = "http://localhost:8080/repos/oliwoli/HushCut/releases/latest"
	}

	client := &http.Client{Timeout: 10 * time.Second}

	var resp *http.Response
	var err error

	maxRetries := 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		req, reqErr := http.NewRequest("GET", updateURL, nil)
		if reqErr != nil {
			log.Printf("Error creating update request: %v", reqErr)
			return
		}
		req.Header.Set("Accept", "application/vnd.github.v3+json")
		req.Header.Set("User-Agent", "HushCut-App")

		resp, err = client.Do(req)
		if err == nil {
			break
		}
		log.Printf("Update check attempt %d failed: %v", attempt, err)
		time.Sleep(time.Duration(attempt) * time.Second)
	}

	if err != nil {
		log.Printf("Update check ultimately failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		log.Println("No releases found on GitHub repo yet.")
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("Unexpected update check response from GitHub: %d", resp.StatusCode)
		return
	}

	var release githubReleaseResponse
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		log.Printf("Error decoding GitHub release response: %v", err)
		return
	}

	if !isNewerVersion(currentVersion, release.TagName) {
		log.Printf("App is up to date (current: %s, latest: %s)", currentVersion, release.TagName)
		return
	}

	var assets []GithubAsset
	for _, as := range release.Assets {
		assets = append(assets, GithubAsset{
			BrowserDownloadUrl: as.BrowserDownloadUrl,
			Name:               as.Name,
			Size:               as.Size,
			ContentType:        as.ContentType,
		})
	}

	updateResp := UpdateResponseV1{
		SchemaVersion: 1,
		LatestVersion: release.TagName,
		URL:           release.HtmlUrl,
		UpdateLabel:   "Update available",
		ShowAlert:     false,
		AlertContent: AlertContent{
			Title:       "Update available",
			Message:     fmt.Sprintf("A new version of HushCut is available.\n%s -> %s", currentVersion, release.TagName),
			ButtonLabel: "Open in Browser",
			ButtonURL:   release.HtmlUrl,
		},
		AlertSeverity: "info",
		GithubData: GithubData{
			TagName: release.TagName,
			HtmlUrl: release.HtmlUrl,
			Assets:  assets,
			Body:    release.Body,
		},
	}

	a.updateInfo = &updateResp
	log.Printf("Update available: %+v", updateResp)
	a.emitEvent("updateAvailable", updateResp)
}

func (a *App) GetUpdateInfo() *UpdateResponseV1 {
	a.emitEvent("updateAvailable", a.updateInfo)
	return a.updateInfo
}
