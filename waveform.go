package main

import (
	"fmt"
	"io"
	"math"
	"net/url"
	"os" // If still writing to file, or for file path handling
	"path/filepath"
	"strings"

	"github.com/go-audio/audio"
	"github.com/go-audio/wav"
	"github.com/wailsapp/wails/v2/pkg/runtime"
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

// New struct for the output JSON matching WaveSurfer's needs for precomputed peaks
type PrecomputedWaveformData struct {
	Duration float64   `json:"duration"` // Duration in seconds
	Peaks    []float64 `json:"peaks"`    // Normalized peak values (0.0 to 1.0) for display, one per pixel/block
}

func (a *App) ProcessWavToLogarithmicPeaks(
	webInputPath string,
	samplesPerPixel int,
	minDisplayDb float64, // e.g., -60.0
	maxDisplayDb float64, // e.g., 0.0
	clipStartSeconds float64,
	clipEndSeconds float64,
) (*PrecomputedWaveformData, error) {

	if samplesPerPixel < 1 {
		return nil, fmt.Errorf("samples_per_pixel must be at least 1")
	}
	if minDisplayDb >= maxDisplayDb {
		return nil, fmt.Errorf("minDisplayDb must be less than maxDisplayDb")
	}
	if clipStartSeconds < 0 {
		return nil, fmt.Errorf("ClipStartSeconds must be non-negative")
	}
	if clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("ClipEndSeconds (%.2f) must be greater than ClipStartSeconds (%.2f)", clipEndSeconds, clipStartSeconds)
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
	if sampleRate == 0 {
		return nil, fmt.Errorf("file '%s' reported 0 sample rate", absPath)
	}
	inputChannels := int(format.NumChannels)
	if inputChannels == 0 {
		return nil, fmt.Errorf("file '%s' reported 0 channels", absPath)
	}

	// Determine effective clip range based on audio duration, if known
	actualClipStartSeconds := clipStartSeconds
	actualClipEndSeconds := clipEndSeconds

	audioFileDuration, err := decoder.Duration() // This is time.Duration
	if err == nil {                              // Duration is known
		fileDurationSeconds := audioFileDuration.Seconds()
		if actualClipStartSeconds >= fileDurationSeconds {
			return &PrecomputedWaveformData{Duration: 0, Peaks: []float64{}}, nil // Clip starts after or at EOF
		}
		if actualClipEndSeconds > fileDurationSeconds {
			actualClipEndSeconds = fileDurationSeconds // Trim clip end to file duration
		}
		if actualClipEndSeconds <= actualClipStartSeconds { // After trimming, clip might be empty/invalid
			return &PrecomputedWaveformData{Duration: 0, Peaks: []float64{}}, nil
		}
	}
	// If err != nil for decoder.Duration(), we proceed without knowing the exact file end, relying on EOF.

	startFrameOffset := int(actualClipStartSeconds * float64(sampleRate))
	endFrameOffset := int(actualClipEndSeconds * float64(sampleRate))

	// If calculated frame offsets result in no frames (e.g., sub-frame duration after clipping)
	if startFrameOffset >= endFrameOffset {
		// Calculate the duration of the intended, possibly tiny, clip.
		effectiveDuration := actualClipEndSeconds - actualClipStartSeconds
		if effectiveDuration < 0 { // Should not happen due to earlier checks, but safety.
			effectiveDuration = 0
		}
		return &PrecomputedWaveformData{Duration: effectiveDuration, Peaks: []float64{}}, nil
	}

	numFramesInClip := endFrameOffset - startFrameOffset
	expectedNumPeaks := 100 // Default capacity
	if numFramesInClip > 0 && samplesPerPixel > 0 {
		expectedNumPeaks = (numFramesInClip + samplesPerPixel - 1) / samplesPerPixel
	}

	processedPeaks := make([]float64, 0, expectedNumPeaks)
	var currentMaxAbsSampleInBlock int32 = 0
	samplesProcessedInBlock := 0
	currentFrameInFile := 0 // Tracks the current frame index from the beginning of the file

	chunkSize := 8192 // Number of samples (not frames) in each read buffer
	if chunkSize%inputChannels != 0 {
		chunkSize = (chunkSize/inputChannels + 1) * inputChannels
	}
	pcmBuffer := &audio.IntBuffer{
		Format: format,
		Data:   make([]int, chunkSize),
	}

processingLoop:
	for {
		if currentFrameInFile >= endFrameOffset { // Already processed or skipped past the clip end
			break
		}

		numSamplesRead, readErr := decoder.PCMBuffer(pcmBuffer)

		if numSamplesRead == 0 {
			if readErr != io.EOF && readErr != nil {
				return nil, fmt.Errorf("error reading PCM chunk: %w", readErr)
			}
			break // EOF or other reason for no samples
		}

		samplesInChunk := pcmBuffer.Data[:numSamplesRead]
		numFramesInChunk := numSamplesRead / inputChannels

		for i := 0; i < numFramesInChunk; i++ {
			frameToProcessIndex := currentFrameInFile
			currentFrameInFile++ // Advance master frame counter

			if frameToProcessIndex >= endFrameOffset { // Reached end of clip segment
				break processingLoop // Break outer loop as well
			}
			if frameToProcessIndex < startFrameOffset { // Skip frames before clip start
				continue
			}

			// Process sample (within the clip segment)
			var maxSampleInFrame int32 = 0
			for ch := 0; ch < inputChannels; ch++ {
				sampleVal := int32(samplesInChunk[i*inputChannels+ch])
				absVal := sampleVal
				if absVal < 0 {
					absVal = -absVal
				}
				if absVal > maxSampleInFrame {
					maxSampleInFrame = absVal
				}
			}

			if maxSampleInFrame > currentMaxAbsSampleInBlock {
				currentMaxAbsSampleInBlock = maxSampleInFrame
			}
			samplesProcessedInBlock++

			if samplesProcessedInBlock >= samplesPerPixel {
				normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0
				dBValue := minDisplayDb
				if normalizedLinearPeak >= 0.000001 { // Approx -120dB threshold for silence
					dBValue = 20 * math.Log10(normalizedLinearPeak)
				}

				if dBValue < minDisplayDb {
					dBValue = minDisplayDb
				} else if dBValue > maxDisplayDb {
					dBValue = maxDisplayDb
				}

				visualHeight := (dBValue - minDisplayDb) / (maxDisplayDb - minDisplayDb)
				if visualHeight < 0.0 {
					visualHeight = 0.0
				}
				if visualHeight > 1.0 {
					visualHeight = 1.0
				}
				processedPeaks = append(processedPeaks, visualHeight)

				currentMaxAbsSampleInBlock = 0
				samplesProcessedInBlock = 0
			}
		} // End of frame processing in chunk

		if readErr == io.EOF { // EOF encountered
			break
		}
		if readErr != nil { // Other read error
			return nil, fmt.Errorf("error reading PCM chunk (mid-file): %w", readErr)
		}
	} // End of chunk reading loop (processingLoop)

	// Handle any remaining samples for the last data point if they fall within the clip
	if samplesProcessedInBlock > 0 {
		// This block is only processed if samples were accumulated from within the clip range
		normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0
		dBValue := minDisplayDb
		if normalizedLinearPeak >= 0.000001 {
			dBValue = 20 * math.Log10(normalizedLinearPeak)
		}
		if dBValue < minDisplayDb {
			dBValue = minDisplayDb
		} else if dBValue > maxDisplayDb {
			dBValue = maxDisplayDb
		}
		visualHeight := (dBValue - minDisplayDb) / (maxDisplayDb - minDisplayDb)
		if visualHeight < 0.0 {
			visualHeight = 0.0
		}
		if visualHeight > 1.0 {
			visualHeight = 1.0
		}
		processedPeaks = append(processedPeaks, visualHeight)
	}

	// Calculate the final duration of the segment for which peaks were generated.
	var finalOutputDuration float64

	// Determine the effective end time of the data used for peaks.
	// actualClipEndSeconds was already capped by file duration if known.
	// currentFrameInFile is the number of frames iterated over from the start of the file.
	effectiveDataEndTimeSeconds := float64(currentFrameInFile) / float64(sampleRate)

	// The peak data cannot extend beyond actualClipEndSeconds (user request, capped by file length)
	// nor beyond where we actually read data (effectiveDataEndTimeSeconds due to EOF).
	finalEffectiveEndBoundary := actualClipEndSeconds
	if effectiveDataEndTimeSeconds < actualClipEndSeconds {
		finalEffectiveEndBoundary = effectiveDataEndTimeSeconds
	}

	if finalEffectiveEndBoundary > actualClipStartSeconds {
		finalOutputDuration = finalEffectiveEndBoundary - actualClipStartSeconds
	} else {
		finalOutputDuration = 0 // Clip start was at or after where data ended
	}

	if finalOutputDuration < 0 { // Safety, should not happen with logic above
		finalOutputDuration = 0
	}

	// If no peaks were actually generated (e.g., clip entirely outside data, or zero effective length), duration should be 0.
	if len(processedPeaks) == 0 {
		finalOutputDuration = 0
	}

	return &PrecomputedWaveformData{
		Duration: finalOutputDuration,
		Peaks:    processedPeaks,
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
	clipStartSeconds float64,
	clipEndSeconds float64,
) (*PrecomputedWaveformData, error) {

	if samplesPerPixel < 1 {
		return nil, fmt.Errorf("samples_per_pixel must be at least 1")
	}
	if clipStartSeconds < 0 {
		return nil, fmt.Errorf("ClipStartSeconds must be non-negative")
	}
	if clipEndSeconds <= clipStartSeconds {
		return nil, fmt.Errorf("ClipEndSeconds (%.2f) must be greater than ClipStartSeconds (%.2f)", clipEndSeconds, clipStartSeconds)
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
	var lastReportedPct float64 = -10.0
	decoder := wav.NewDecoder(file)

	if !decoder.IsValidFile() {
		return nil, fmt.Errorf("'%s' is not a valid WAV file", absPath)
	}

	// This function specifically supports 16-bit PCM WAV files.
	if decoder.WavAudioFormat != 1 || decoder.BitDepth != 16 {
		return nil, fmt.Errorf("unsupported WAV format: only 16-bit PCM is supported (got %d-bit, format %d)", decoder.BitDepth, decoder.WavAudioFormat)
	}

	format := decoder.Format()
	if format == nil {
		return nil, fmt.Errorf("could not retrieve audio format details from '%s'", absPath)
	}
	sampleRate := int(format.SampleRate)
	if sampleRate == 0 {
		return nil, fmt.Errorf("file '%s' reported 0 sample rate", absPath)
	}
	inputChannels := int(format.NumChannels)
	if inputChannels == 0 {
		return nil, fmt.Errorf("file '%s' reported 0 channels", absPath)
	}

	// Determine effective clip range based on audio duration, if known
	actualClipStartSeconds := clipStartSeconds
	actualClipEndSeconds := clipEndSeconds

	audioFileDuration, err := decoder.Duration() // This is time.Duration
	if err == nil {                              // Duration is known
		fileDurationSeconds := audioFileDuration.Seconds()
		if actualClipStartSeconds >= fileDurationSeconds {
			return &PrecomputedWaveformData{Duration: 0, Peaks: []float64{}}, nil // Clip starts after or at EOF
		}
		if actualClipEndSeconds > fileDurationSeconds {
			actualClipEndSeconds = fileDurationSeconds // Trim clip end to file duration
		}
		if actualClipEndSeconds <= actualClipStartSeconds { // After trimming, clip might be empty/invalid
			return &PrecomputedWaveformData{Duration: 0, Peaks: []float64{}}, nil
		}
	}
	// If err != nil for decoder.Duration(), we proceed without knowing the exact file end, relying on EOF.

	startFrameOffset := int(actualClipStartSeconds * float64(sampleRate))
	endFrameOffset := int(actualClipEndSeconds * float64(sampleRate))

	if startFrameOffset >= endFrameOffset {
		effectiveDuration := actualClipEndSeconds - actualClipStartSeconds
		if effectiveDuration < 0 {
			effectiveDuration = 0
		}
		return &PrecomputedWaveformData{Duration: effectiveDuration, Peaks: []float64{}}, nil
	}

	numFramesInClip := endFrameOffset - startFrameOffset
	expectedNumPeaks := 100 // Default capacity
	if numFramesInClip > 0 && samplesPerPixel > 0 {
		expectedNumPeaks = (numFramesInClip + samplesPerPixel - 1) / samplesPerPixel
	}

	processedPeaks := make([]float64, 0, expectedNumPeaks)
	var currentMaxAbsSampleInBlock int32 = 0
	samplesProcessedInBlock := 0
	currentFrameInFile := 0 // Tracks the current frame index from the beginning of the file

	chunkSize := 8192 // Number of samples (not frames) in each read buffer
	if chunkSize%inputChannels != 0 {
		chunkSize = (chunkSize/inputChannels + 1) * inputChannels
	}
	pcmBuffer := &audio.IntBuffer{
		Format: format,
		Data:   make([]int, chunkSize),
	}

processingLoop:
	for {
		if currentFrameInFile >= endFrameOffset {
			break
		}

		numSamplesRead, readErr := decoder.PCMBuffer(pcmBuffer)

		if numSamplesRead == 0 {
			break
		}

		if numSamplesRead > 0 && totalBytes > 0 {
			// Ask the file handle for its current position (offset in bytes).
			currentPos, seekErr := file.Seek(0, io.SeekCurrent)

			// Only report progress if we can successfully get the position.
			if seekErr == nil {
				percentage := (float64(currentPos) / float64(totalBytes)) * 100
				if percentage > 100 {
					percentage = 100
				}

				if percentage-lastReportedPct >= 5.0 {
					runtime.EventsEmit(a.ctx, "waveform:progress", WaveformProgress{
						FilePath:   webInputPath,
						ClipStart:  clipStartSeconds,
						ClipEnd:    clipEndSeconds,
						Percentage: percentage,
					})
					lastReportedPct = percentage
				}
			}
		}

		samplesInChunk := pcmBuffer.Data[:numSamplesRead]
		numFramesInChunk := numSamplesRead / inputChannels

		for i := 0; i < numFramesInChunk; i++ {
			frameToProcessIndex := currentFrameInFile
			currentFrameInFile++

			if frameToProcessIndex >= endFrameOffset {
				break processingLoop
			}
			if frameToProcessIndex < startFrameOffset {
				continue
			}

			var maxSampleInFrame int32 = 0
			for ch := 0; ch < inputChannels; ch++ {
				sampleVal := int32(samplesInChunk[i*inputChannels+ch])
				absVal := sampleVal
				if absVal < 0 {
					absVal = -absVal
				}
				if absVal > maxSampleInFrame {
					maxSampleInFrame = absVal
				}
			}

			if maxSampleInFrame > currentMaxAbsSampleInBlock {
				currentMaxAbsSampleInBlock = maxSampleInFrame
			}
			samplesProcessedInBlock++

			if samplesProcessedInBlock >= samplesPerPixel {
				// --- Linear Peak Calculation ---
				// Normalize the max absolute sample value. 32767 is the max for 16-bit audio.
				normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0
				if normalizedLinearPeak > 1.0 { // Clamp to 1.0 for safety
					normalizedLinearPeak = 1.0
				}
				processedPeaks = append(processedPeaks, normalizedLinearPeak)
				// --- End of Linear Peak Calculation ---

				currentMaxAbsSampleInBlock = 0
				samplesProcessedInBlock = 0
			}
		}

		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("error reading PCM chunk (mid-file): %w", readErr)
		}
	}

	// Handle any remaining samples for the last data point if they fall within the clip
	if samplesProcessedInBlock > 0 {
		// --- Final Linear Peak Calculation ---
		normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0
		if normalizedLinearPeak > 1.0 {
			normalizedLinearPeak = 1.0
		}
		processedPeaks = append(processedPeaks, normalizedLinearPeak)
		// --- End of Final Linear Peak Calculation ---
	}

	// Calculate the final duration of the segment for which peaks were generated.
	var finalOutputDuration float64
	effectiveDataEndTimeSeconds := float64(currentFrameInFile) / float64(sampleRate)
	finalEffectiveEndBoundary := actualClipEndSeconds
	if effectiveDataEndTimeSeconds < actualClipEndSeconds {
		finalEffectiveEndBoundary = effectiveDataEndTimeSeconds
	}

	if finalEffectiveEndBoundary > actualClipStartSeconds {
		finalOutputDuration = finalEffectiveEndBoundary - actualClipStartSeconds
	} else {
		finalOutputDuration = 0
	}

	if finalOutputDuration < 0 {
		finalOutputDuration = 0
	}

	if len(processedPeaks) == 0 {
		finalOutputDuration = 0
	}

	runtime.EventsEmit(a.ctx, "waveform:done", WaveformProgress{
		FilePath:  webInputPath,
		ClipStart: clipStartSeconds,
		ClipEnd:   clipEndSeconds,
	})

	return &PrecomputedWaveformData{
		Duration: finalOutputDuration,
		Peaks:    processedPeaks,
	}, nil
}
