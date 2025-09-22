package main

import (
	"fmt"
	"io"
	"log"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-audio/audio"
	"github.com/go-audio/wav"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sync/singleflight"
)

func (a *App) resolvePublicAudioPath(webPath string) (string, error) {
	var cleanPath string

	// Check if the input is a full URL
	if strings.HasPrefix(webPath, "http://") || strings.HasPrefix(webPath, "https://") {
		parsedURL, err := url.Parse(webPath)
		if err != nil {
			return "", fmt.Errorf("invalid URL: %w", err)
		}
		cleanPath = parsedURL.Path
	} else {
		cleanPath = webPath
	}

	// Normalize the path by removing leading slashes
	cleanPath = strings.TrimPrefix(cleanPath, "/")

	// Combine and clean the full path
	fullPath := filepath.Join(a.tmpPath, cleanPath)
	fullPath = filepath.Clean(fullPath)

	return fullPath, nil
}

func (a *App) GetWaveform(filePath string, samplesPerPixel int, peakType string, minDb float64, clipStartSeconds float64, clipEndSeconds float64) (*PrecomputedWaveformData, error) {
	maxDb := 0.0
	start := time.Now()

	if err := a.WaitForFile(filePath); err != nil {
		return nil, fmt.Errorf("error waiting for file to be ready for silence detection: %w", err)
	}
	log.Printf("WaitForFile took: %s (file: %s)", time.Since(start), filePath)

	data, err := a.GetOrGenerateWaveformWithCache(filePath, samplesPerPixel, peakType, minDb, maxDb, clipStartSeconds, clipEndSeconds)
	if err != nil {
		runtime.LogError(a.ctx, fmt.Sprintf("Error getting or generating waveform data for %s: %v", filePath, err))
		return nil, fmt.Errorf("failed to get/generate waveform for '%s': %v", filePath, err)
	}
	return data, nil
}

func sliceWaveform(full *PrecomputedWaveformData, startSec, endSec float64) *PrecomputedWaveformData {
	if endSec < 0 || endSec > full.Duration {
		endSec = full.Duration
	}
	if startSec < 0 {
		startSec = 0
	}

	startIndex := int((startSec / full.Duration) * float64(len(full.Peaks)))
	endIndex := int((endSec / full.Duration) * float64(len(full.Peaks)))
	if endIndex > len(full.Peaks) {
		endIndex = len(full.Peaks)
	}

	return &PrecomputedWaveformData{
		Peaks:    full.Peaks[startIndex:endIndex],
		Duration: endSec - startSec,
		// copy any other metadata needed
	}
}

func (k WaveformCacheKey) String() string {
	return fmt.Sprintf("%s|%d|%s|%f|%f",
		k.FilePath,
		k.SamplesPerPixel,
		k.PeakType,
		k.MinDb,
		k.MaxDb,
	)
}

var waveformGroup singleflight.Group

func (a *App) GetOrGenerateWaveformWithCache(
	webInputPath string,
	samplesPerPixel int,
	peakType string,
	minDb float64,
	maxDb float64,
	clipStartSeconds float64,
	clipEndSeconds float64,
) (*PrecomputedWaveformData, error) {

	localFSPath, err := a.resolvePublicAudioPath(webInputPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve web input path '%s' for pre-check: %w", webInputPath, err)
	}
	a.updateFileUsage(localFSPath)

	if err := a.WaitForFile(localFSPath); err != nil {
		return nil, fmt.Errorf("error waiting for file '%s' to be ready: %w", webInputPath, err)
	}

	if _, statErr := os.Stat(localFSPath); os.IsNotExist(statErr) {
		return nil, fmt.Errorf("audio file does not exist at resolved path '%s' (from '%s')", localFSPath, webInputPath)
	} else if statErr != nil {
		return nil, fmt.Errorf("error stating file at resolved path '%s': %w", localFSPath, statErr)
	}

	key := WaveformCacheKey{
		FilePath:        webInputPath,
		SamplesPerPixel: samplesPerPixel,
		PeakType:        peakType,
		MinDb:           minDb,
		MaxDb:           maxDb,
	}

	// Single-flight ensures only 1 goroutine computes the waveform per key
	v, err, _ := waveformGroup.Do(key.String(), func() (any, error) {
		a.cacheMutex.RLock()
		cachedData, found := a.waveformCache[key]
		a.cacheMutex.RUnlock()
		if found {
			//log.Println("CACHE HIT for key", key)
			return cachedData, nil
		}

		//log.Println("CACHE MISS for key", key)

		var waveformData *PrecomputedWaveformData
		var err error
		switch peakType {
		case "linear":
			waveformData, err = a.ProcessWavToLinearPeaks(webInputPath, samplesPerPixel)
		case "logarithmic":
			waveformData, err = a.ProcessWavToLogarithmicPeaks(webInputPath, samplesPerPixel, minDb, maxDb)
		default:
			err = fmt.Errorf("unknown peakType: '%s'", peakType)
		}
		if err != nil {
			return nil, err
		}

		a.cacheMutex.Lock()
		a.waveformCache[key] = waveformData
		a.cacheMutex.Unlock()
		return waveformData, nil
	})
	if err != nil {
		return nil, fmt.Errorf("error during waveform processing for '%s': %w", webInputPath, err)
	}

	cachedData := v.(*PrecomputedWaveformData)
	return sliceWaveform(cachedData, clipStartSeconds, clipEndSeconds), nil
}

// struct for the output JSON matching WaveSurfer's needs for precomputed peaks
type PrecomputedWaveformData struct {
	Duration float64   `json:"duration"` // in seconds
	Peaks    []float64 `json:"peaks"`    // Normalized peak values (0.0 to 1.0) for display, one per pixel/block
}

func (a *App) ProcessWavToLogarithmicPeaks(
	webInputPath string,
	samplesPerPixel int,
	minDisplayDb float64, // e.g., -60.0
	maxDisplayDb float64, // e.g., 0.0
) (*PrecomputedWaveformData, error) {

	if samplesPerPixel < 1 {
		return nil, fmt.Errorf("samples_per_pixel must be at least 1")
	}
	if minDisplayDb >= maxDisplayDb {
		return nil, fmt.Errorf("minDisplayDb must be less than maxDisplayDb")
	}

	absPath, err := a.resolvePublicAudioPath(webInputPath)
	if err != nil {
		return nil, fmt.Errorf("path resolution error: %w", err)
	}
	if err := a.WaitForFile(absPath); err != nil {
		return nil, fmt.Errorf("error waiting for file to be ready: %w", err)
	}

	file, err := os.Open(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open input file '%s': %w", absPath, err)
	}
	defer file.Close()

	decoder := wav.NewDecoder(file)
	if !decoder.IsValidFile() {
		return nil, fmt.Errorf("'%s' is not a valid WAV file", absPath)
	}
	if decoder.WavAudioFormat != 1 || decoder.BitDepth != 16 {
		return nil, fmt.Errorf("unsupported WAV format: only 16-bit PCM is supported (got %d-bit, format %d)", decoder.BitDepth, decoder.WavAudioFormat)
	}

	format := decoder.Format()
	if format == nil {
		return nil, fmt.Errorf("could not retrieve audio format details from '%s'", absPath)
	}
	sampleRate := int(format.SampleRate)
	inputChannels := int(format.NumChannels)

	// Estimate number of peaks
	duration, _ := decoder.Duration()
	expectedNumPeaks := 100
	if duration > 0 {
		numFrames := int(float64(sampleRate) * duration.Seconds())
		expectedNumPeaks = (numFrames + samplesPerPixel - 1) / samplesPerPixel
	}

	peaks := make([]float64, 0, expectedNumPeaks)

	chunkSize := 8192
	if chunkSize%inputChannels != 0 {
		chunkSize = (chunkSize/inputChannels + 1) * inputChannels
	}
	pcmBuffer := &audio.IntBuffer{
		Format: format,
		Data:   make([]int, chunkSize),
	}

	var (
		currentMaxAbs   int32
		samplesInBlock  int
		totalFrames     int
		lastReportedPct float64 = -10.0
	)

	fileInfo, err := file.Stat() // Get stats ONCE here
	if err != nil {
		return nil, fmt.Errorf("could not get file info for '%s': %w", absPath, err)
	}
	totalBytes := fileInfo.Size()

	for {
		numSamples, readErr := decoder.PCMBuffer(pcmBuffer)
		if numSamples == 0 {
			if readErr != io.EOF && readErr != nil {
				return nil, fmt.Errorf("error reading PCM chunk: %w", readErr)
			}
			break
		}
		defer file.Close()

		// Optional progress
		if totalBytes > 0 {
			if pos, err := file.Seek(0, io.SeekCurrent); err == nil {
				pct := (float64(pos) / float64(totalBytes)) * 100
				if pct-lastReportedPct >= 5 {
					runtime.EventsEmit(a.ctx, "waveform:progress", WaveformProgress{
						FilePath:   webInputPath,
						Percentage: pct,
					})
					lastReportedPct = pct
				}
			}
		}

		for i := 0; i < numSamples; i += inputChannels {
			var maxFrameSample int32
			for ch := range inputChannels {
				val := int32(pcmBuffer.Data[i+ch])
				if val < 0 {
					val = -val
				}
				if val > maxFrameSample {
					maxFrameSample = val
				}
			}

			if maxFrameSample > currentMaxAbs {
				currentMaxAbs = maxFrameSample
			}
			samplesInBlock++
			totalFrames++

			if samplesInBlock >= samplesPerPixel {
				normalized := float64(currentMaxAbs) / 32767.0
				dB := minDisplayDb
				if normalized > 0 {
					dB = 20 * math.Log10(normalized)
				}
				if dB < minDisplayDb {
					dB = minDisplayDb
				} else if dB > maxDisplayDb {
					dB = maxDisplayDb
				}
				visual := (dB - minDisplayDb) / (maxDisplayDb - minDisplayDb)
				if visual < 0 {
					visual = 0
				} else if visual > 1 {
					visual = 1
				}
				peaks = append(peaks, visual)
				currentMaxAbs = 0
				samplesInBlock = 0
			}
		}

		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("error reading PCM chunk: %w", readErr)
		}
	}

	// leftover samples
	if samplesInBlock > 0 {
		normalized := float64(currentMaxAbs) / 32767.0
		dB := minDisplayDb
		if normalized > 0.000001 {
			dB = 20 * math.Log10(normalized)
		}
		if dB < minDisplayDb {
			dB = minDisplayDb
		} else if dB > maxDisplayDb {
			dB = maxDisplayDb
		}
		visual := (dB - minDisplayDb) / (maxDisplayDb - minDisplayDb)
		if visual < 0.0 {
			visual = 0.0
		} else if visual > 1.0 {
			visual = 1.0
		}
		peaks = append(peaks, visual)
	}

	finalDuration := float64(totalFrames) / float64(sampleRate)

	runtime.EventsEmit(a.ctx, "waveform:done", WaveformProgress{FilePath: webInputPath})

	return &PrecomputedWaveformData{
		Duration: finalDuration,
		Peaks:    peaks,
	}, nil
}

type WaveformProgress struct {
	ClipStart  float64 `json:"clipStart"`
	ClipEnd    float64 `json:"clipEnd"`
	FilePath   string  `json:"filePath"`
	Percentage float64 `json:"percentage"`
}

func (a *App) ProcessWavToLinearPeaks(
	webInputPath string,
	samplesPerPixel int,
) (*PrecomputedWaveformData, error) {

	if samplesPerPixel < 1 {
		return nil, fmt.Errorf("samples_per_pixel must be at least 1")
	}

	absPath, err := a.resolvePublicAudioPath(webInputPath)
	if err != nil {
		return nil, fmt.Errorf("path resolution error: %w", err)
	}
	if err := a.WaitForFile(absPath); err != nil {
		return nil, fmt.Errorf("error waiting for file to be ready: %w", err)
	}

	file, err := os.Open(absPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open input file '%s': %w", absPath, err)
	}
	defer file.Close()

	fileInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("could not get file info for '%s': %w", absPath, err)
	}
	totalBytes := fileInfo.Size()

	decoder := wav.NewDecoder(file)
	if !decoder.IsValidFile() {
		return nil, fmt.Errorf("'%s' is not a valid WAV file", absPath)
	}

	if decoder.WavAudioFormat != 1 || decoder.BitDepth != 16 {
		return nil, fmt.Errorf("unsupported WAV format: only 16-bit PCM is supported (got %d-bit, format %d)", decoder.BitDepth, decoder.WavAudioFormat)
	}

	format := decoder.Format()
	if format == nil {
		return nil, fmt.Errorf("could not retrieve audio format details from '%s'", absPath)
	}
	sampleRate := int(format.SampleRate)
	inputChannels := int(format.NumChannels)

	// Estimate number of peaks (optional)
	duration, _ := decoder.Duration()
	expectedNumPeaks := 100
	if duration > 0 {
		numFrames := int(float64(sampleRate) * duration.Seconds())
		expectedNumPeaks = (numFrames + samplesPerPixel - 1) / samplesPerPixel
	}

	peaks := make([]float64, 0, expectedNumPeaks)

	chunkSize := 8192
	if chunkSize%inputChannels != 0 {
		chunkSize = (chunkSize/inputChannels + 1) * inputChannels
	}
	pcmBuffer := &audio.IntBuffer{
		Format: format,
		Data:   make([]int, chunkSize),
	}

	var (
		currentMaxAbs   int32
		samplesInBlock  int
		lastReportedPct float64 = -10.0
		totalFrames     int
	)

	for {
		numSamples, readErr := decoder.PCMBuffer(pcmBuffer)
		if numSamples == 0 {
			break
		}

		// Optional progress reporting
		if totalBytes > 0 {
			if pos, err := file.Seek(0, io.SeekCurrent); err == nil {
				pct := (float64(pos) / float64(totalBytes)) * 100
				if pct-lastReportedPct >= 5 {
					runtime.EventsEmit(a.ctx, "waveform:progress", WaveformProgress{
						FilePath:   webInputPath,
						Percentage: pct,
					})
					lastReportedPct = pct
				}
			}
		}

		for i := 0; i < numSamples; i += inputChannels {
			var maxFrameSample int32
			for ch := 0; ch < inputChannels; ch++ {
				val := int32(pcmBuffer.Data[i+ch])
				if val < 0 {
					val = -val
				}
				if val > maxFrameSample {
					maxFrameSample = val
				}
			}

			if maxFrameSample > currentMaxAbs {
				currentMaxAbs = maxFrameSample
			}
			samplesInBlock++
			totalFrames++

			if samplesInBlock >= samplesPerPixel {
				peaks = append(peaks, float64(currentMaxAbs)/32767.0)
				currentMaxAbs = 0
				samplesInBlock = 0
			}
		}

		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("error reading PCM: %w", readErr)
		}
	}

	// Handle leftover samples
	if samplesInBlock > 0 {
		peaks = append(peaks, float64(currentMaxAbs)/32767.0)
	}

	finalDuration := float64(totalFrames) / float64(sampleRate)

	runtime.EventsEmit(a.ctx, "waveform:done", WaveformProgress{
		FilePath: webInputPath,
	})

	return &PrecomputedWaveformData{
		Duration: finalDuration,
		Peaks:    peaks,
	}, nil
}
