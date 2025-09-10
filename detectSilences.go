package main

import (
	"bufio"
	"bytes"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
)

func (a *App) DetectSilences(
	filePath string,
	loudnessThreshold float64,
	minSilenceDurationSeconds float64,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
	minContentDuration float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
	framerate float64,
) ([]SilencePeriod, error) {
	if err := a.waitForValidLicense(); err != nil {
		return nil, fmt.Errorf("license validation failed: %w", err)
	}

	if err := a.waitForFfmpeg(); err != nil {
		return nil, err
	}

	if clipStartSeconds < 0 {
		clipStartSeconds = 0
	}
	if clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("clip end (%.3f) must be greater than start (%.3f)", clipEndSeconds, clipStartSeconds)
	}

	absPath := filepath.Join(a.tmpPath, filePath)
	// Mark the input file as used after its absolute path is determined
	a.updateFileUsage(absPath)
	loudnessThresholdStr := fmt.Sprintf("%fdB", loudnessThreshold)
	if minSilenceDurationSeconds < 0.009 {
		minSilenceDurationSeconds = 0.009
	}

	minSilenceDurationForFFmpeg := fmt.Sprintf("%f", minSilenceDurationSeconds)

	filterGraph := fmt.Sprintf("atrim=start=%.6f:end=%.6f,silencedetect=n=%s:d=%s",
		clipStartSeconds, clipEndSeconds,
		loudnessThresholdStr, minSilenceDurationForFFmpeg,
	)

	args := []string{
		"-nostdin", "-i", absPath, "-af", filterGraph, "-f", "null", "-",
	}
	cmd := ExecCommand(a.ffmpegBinaryPath, args...)
	var outputBuffer bytes.Buffer
	cmd.Stderr = &outputBuffer

	if err := cmd.Run(); err != nil && len(outputBuffer.String()) == 0 {
		return nil, fmt.Errorf("ffmpeg failed: %w. Output: %s", err, outputBuffer.String())
	}

	var preliminarySilences []SilencePeriod
	silenceStartRegex := regexp.MustCompile(`silence_start:\s*([0-9]+\.?[0-9]*)`)
	silenceEndRegex := regexp.MustCompile(`silence_end:\s*([0-9]+\.?[0-9]*)`)
	scanner := bufio.NewScanner(&outputBuffer)

	var currentStartTime float64 = -1
	const epsilon = 0.001

	for scanner.Scan() {
		line := scanner.Text()
		if match := silenceStartRegex.FindStringSubmatch(line); len(match) > 1 {
			start, _ := strconv.ParseFloat(match[1], 64)
			currentStartTime = start
		}

		if match := silenceEndRegex.FindStringSubmatch(line); len(match) > 1 && currentStartTime != -1 {
			endTime, _ := strconv.ParseFloat(match[1], 64)

			adjustedStart := currentStartTime
			adjustedEnd := endTime

			if adjustedStart > clipStartSeconds+epsilon {
				adjustedStart += paddingLeftSeconds
			}
			if adjustedEnd < clipEndSeconds-epsilon {
				adjustedEnd -= paddingRightSeconds
			}

			adjustedStart = math.Max(adjustedStart, clipStartSeconds)
			adjustedEnd = math.Min(adjustedEnd, clipEndSeconds)

			if adjustedEnd-adjustedStart >= minSilenceDurationSeconds {
				preliminarySilences = append(preliminarySilences, SilencePeriod{
					Start: adjustedStart,
					End:   adjustedEnd,
				})
			}
			currentStartTime = -1
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading ffmpeg output: %w", err)
	}

	if len(preliminarySilences) == 0 {
		return []SilencePeriod{}, nil
	}

	if first := preliminarySilences[0]; first.Start-clipStartSeconds > epsilon && first.Start-clipStartSeconds < minContentDuration {
		preliminarySilences[0].Start = clipStartSeconds
	}
	if last := preliminarySilences[len(preliminarySilences)-1]; clipEndSeconds-last.End > epsilon && clipEndSeconds-last.End < minContentDuration {
		preliminarySilences[len(preliminarySilences)-1].End = clipEndSeconds
	}

	var mergedSilences []SilencePeriod
	if len(preliminarySilences) > 0 {
		current := preliminarySilences[0]
		for i := 1; i < len(preliminarySilences); i++ {
			next := preliminarySilences[i]
			if contentDuration := next.Start - current.End; contentDuration < minContentDuration {
				current.End = next.End
			} else {
				mergedSilences = append(mergedSilences, current)
				current = next
			}
		}
		mergedSilences = append(mergedSilences, current)
	}

	return mergedSilences, nil
}

func (a *App) GetOrDetectSilencesWithCache(
	filePath string,
	loudnessThreshold float64,
	minSilenceDurationSeconds float64,
	paddingLeftSeconds float64,
	paddingRightSeconds float64,
	minContentDuration float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
	framerate float64,
) ([]SilencePeriod, error) {
	key := CacheKey{
		FilePath:                  filePath,
		LoudnessThreshold:         loudnessThreshold,
		MinSilenceDurationSeconds: minSilenceDurationSeconds,
		PaddingLeftSeconds:        paddingLeftSeconds,
		PaddingRightSeconds:       paddingRightSeconds,
		MinContentDuration:        minContentDuration,
		ClipStartSeconds:          clipStartSeconds,
		ClipEndSeconds:            clipEndSeconds,
	}

	// 1. Try to read from cache (read lock)
	a.cacheMutex.RLock()
	cachedSilences, found := a.silenceCache[key]
	a.cacheMutex.RUnlock()

	if found {
		//log.Println("Cache hit for key:", key.FilePath, key.LoudnessThreshold, key.MinSilenceDurationSeconds) // For debugging
		return cachedSilences, nil
	}

	// log.Println("Cache miss for key:", key.FilePath, key.LoudnessThreshold, key.MinSilenceDurationSeconds) // For debugging

	// 2. If not found, perform the detection
	silences, err := a.DetectSilences(
		filePath,
		loudnessThreshold,
		minSilenceDurationSeconds,
		paddingLeftSeconds,
		paddingRightSeconds,
		minContentDuration,
		clipStartSeconds,
		clipEndSeconds,
		framerate,
	)
	if err != nil {
		// Do not cache errors, so subsequent calls can retry.
		return nil, err
	}

	// 3. Store the result in the cache (write lock)
	a.cacheMutex.Lock()
	a.silenceCache[key] = silences
	a.cacheMutex.Unlock()
	return silences, nil
}
