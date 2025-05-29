package main

import (
	"fmt"
	"io"
	"log"
	"math"
	"net/url"
	"os" // If still writing to file, or for file path handling
	"path/filepath"
	"strings"
	"time"

	"github.com/go-audio/audio"
	"github.com/go-audio/wav"
)

func resolvePublicAudioPath(webPath string) (string, error) {
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


    // Construct the absolute path to the public directory
    publicDir := filepath.Join(".", "wav_files")

    // Combine and clean the full path
    fullPath := filepath.Join(publicDir, cleanPath)
    fullPath = filepath.Clean(fullPath)

    return fullPath, nil
}


// New struct for the output JSON matching WaveSurfer's needs for precomputed peaks
type PrecomputedWaveformData struct {
	Duration float64   `json:"duration"` // Duration in seconds
	Peaks    []float64 `json:"peaks"`    // Normalized peak values (0.0 to 1.0) for display, one per pixel/block
}

// ProcessWavToLogarithmicPeaks processes a WAV file and returns data for a logarithmic dB display.
func ProcessWavToLogarithmicPeaks(
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

	absPath, err := resolvePublicAudioPath(webInputPath)
	if err != nil {
		return nil, fmt.Errorf("path resolution error: %w", err)
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

	// Ensure it's 16-bit PCM, as your original code supported this. Adapt if other formats are needed.
	if decoder.WavAudioFormat != 1 || decoder.BitDepth != 16 {
		return nil, fmt.Errorf("unsupported WAV format: only 16-bit PCM is supported (got %d-bit, format %d)", decoder.BitDepth, decoder.WavAudioFormat)
	}

	format := decoder.Format()
	if format == nil {
		return nil, fmt.Errorf("could not retrieve audio format details from '%s'", absPath)
	}
	sampleRate := int(format.SampleRate)
	inputChannels := int(format.NumChannels)
	if inputChannels == 0 {
		return nil, fmt.Errorf("file '%s' reported 0 channels", absPath)
	}
    
    // Attempt to get duration
    audioDuration, err := decoder.Duration() // This returns time.Duration
    if err != nil {
        // Fallback or error if duration is critical and not found
        log.Printf("Warning: could not get duration directly from decoder: %v. Will estimate later.", err)
        // You might need to calculate it based on total samples if this fails.
    }


	var processedPeaks []float64
	var currentMaxAbsSampleInBlock int32 = 0 // Max absolute sample value in the current block
	samplesProcessedInBlock := 0
    totalFramesProcessed := 0


	// Buffer for reading audio chunks
	// chunkSize should be a multiple of inputChannels if you are processing frame by frame from it
	chunkSize := 8192 
	if chunkSize % inputChannels != 0 {
		chunkSize = (chunkSize/inputChannels +1) * inputChannels
	}
	pcmBuffer := &audio.IntBuffer{
		Format: format,
		Data:   make([]int, chunkSize),
	}

	for {
		numSamplesRead, err := decoder.PCMBuffer(pcmBuffer) // numSamplesRead is total samples in this chunk
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("error reading PCM chunk: %w", err)
		}
		if numSamplesRead == 0 {
			break
		}

		samplesInChunk := pcmBuffer.Data[:numSamplesRead]
		numFramesInChunk := numSamplesRead / inputChannels
        totalFramesProcessed += numFramesInChunk


		for i := 0; i < numFramesInChunk; i++ { // For each audio frame in the chunk
			//var sumAbs int64 = 0 // Sum of absolute sample values for multi-channel max, or just use one channel if preferred for true peak
                                 // For true peak of a mono signal from stereo, often you take max(abs(L), abs(R))
                                 // For simplicity here, let's average then take absolute.
                                 // Or, find the sample with the largest absolute magnitude across channels.
            
            var maxSampleInFrame int32 = 0 // Max absolute sample value within this multi-channel frame

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
				// 1. Normalize absolute peak to 0.0 - 1.0 (linear amplitude)
				// Max possible value for a 16-bit sample is 32767 (not 32768, which is -min)
				normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0 

				// 2. Convert to dB
				var dBValue float64
				if normalizedLinearPeak < 0.000001 { // Threshold for silence (approx -120dB)
					dBValue = minDisplayDb 
				} else {
					dBValue = 20 * math.Log10(normalizedLinearPeak)
				}

				// Clamp dBValue to our display range (e.g., -60dB to 0dB)
				if dBValue < minDisplayDb {
					dBValue = minDisplayDb
				} else if dBValue > maxDisplayDb {
					dBValue = maxDisplayDb
				}

				// 3. Scale dB to visual height 0.0 - 1.0
				visualHeight := (dBValue - minDisplayDb) / (maxDisplayDb - minDisplayDb)
				// Ensure it's strictly within [0,1] due to potential float inaccuracies
				if visualHeight < 0.0 { visualHeight = 0.0 }
				if visualHeight > 1.0 { visualHeight = 1.0 }

				processedPeaks = append(processedPeaks, visualHeight)

				// Reset for the next block
				currentMaxAbsSampleInBlock = 0
				samplesProcessedInBlock = 0
			}
		}
	}

	// Handle any remaining samples for the last data point
	if samplesProcessedInBlock > 0 {
		normalizedLinearPeak := float64(currentMaxAbsSampleInBlock) / 32767.0
		var dBValue float64
		if normalizedLinearPeak < 0.000001 { dBValue = minDisplayDb } else { dBValue = 20 * math.Log10(normalizedLinearPeak) }
		if dBValue < minDisplayDb { dBValue = minDisplayDb } else if dBValue > maxDisplayDb { dBValue = maxDisplayDb }
		visualHeight := (dBValue - minDisplayDb) / (maxDisplayDb - minDisplayDb)
		if visualHeight < 0.0 { visualHeight = 0.0 } else if visualHeight > 1.0 { visualHeight = 1.0 }
		processedPeaks = append(processedPeaks, visualHeight)
	}
    
    // Recalculate duration based on frames processed if initial value was problematic
    calculatedDuration := float64(totalFramesProcessed) / float64(sampleRate)
    if audioDuration.Seconds() <= 0 || math.Abs(audioDuration.Seconds()-calculatedDuration) > 0.1 {
        log.Printf("Using calculated duration: %.2f seconds (initial was: %.2f)", calculatedDuration, audioDuration.Seconds())
        audioDuration = time.Duration(calculatedDuration * float64(time.Second))
    }


	return &PrecomputedWaveformData{
		Duration: audioDuration.Seconds(),
		Peaks:    processedPeaks,
	}, nil
}