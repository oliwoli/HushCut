package main

import (
	"testing"
)

func TestParseWhereOutput(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{
			name:  "single result no spaces",
			input: "C:\\ffmpeg\\bin\\ffmpeg.exe\r\n",
			want:  "C:\\ffmpeg\\bin\\ffmpeg.exe",
		},
		{
			name:  "single result with spaces",
			input: "C:\\Users\\John Doe\\ffmpeg\\bin\\ffmpeg.exe\r\n",
			want:  "C:\\Users\\John Doe\\ffmpeg\\bin\\ffmpeg.exe",
		},
		{
			name:  "multiple results, choose first",
			input: "C:\\Path1\\ffmpeg.exe\r\nC:\\Path2\\ffmpeg.exe\r\n",
			want:  "C:\\Path1\\ffmpeg.exe",
		},
		{
			name:  "multiple results with spaces, choose first",
			input: "C:\\Path1 Space\\ffmpeg.exe\r\nC:\\Path2 Space\\ffmpeg.exe\r\n",
			want:  "C:\\Path1 Space\\ffmpeg.exe",
		},
		{
			name:    "empty output gives error",
			input:   "\r\n",
			wantErr: true,
		},
		{
			name:  "mixed line endings",
			input: "C:\\Path1\\ffmpeg.exe\nC:\\Path2\\ffmpeg.exe\r\n",
			want:  "C:\\Path1\\ffmpeg.exe",
		},
		{
			name:  "leading whitespace",
			input: "   C:\\ffmpeg\\bin\\ffmpeg.exe\r\n",
			want:  "C:\\ffmpeg\\bin\\ffmpeg.exe",
		},
		{
			name:  "trailing whitespace",
			input: "C:\\ffmpeg\\bin\\ffmpeg.exe    \r\n",
			want:  "C:\\ffmpeg\\bin\\ffmpeg.exe",
		},
		{
			name:  "ignore non-path lines",
			input: "INFO: Something weird\r\nC:\\ffmpeg\\bin\\ffmpeg.exe\r\n",
			want:  "C:\\ffmpeg\\bin\\ffmpeg.exe",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseWhereOutput(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("unexpected error state: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

func TestResolveAudioStreamAndChannel(t *testing.T) {
	tests := []struct {
		name              string
		channelIndex      int
		audioStreams      []AudioStream
		wantStreamIndex   int
		wantChannelStream int
		wantErr           bool
	}{
		{
			name:         "4 mono streams - channel 0",
			channelIndex: 0,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 1},
				{FFmpegIndex: 2, Channels: 1},
				{FFmpegIndex: 3, Channels: 1},
				{FFmpegIndex: 4, Channels: 1},
			},
			wantStreamIndex:   0,
			wantChannelStream: 0,
		},
		{
			name:         "4 mono streams - channel 1",
			channelIndex: 1,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 1},
				{FFmpegIndex: 2, Channels: 1},
				{FFmpegIndex: 3, Channels: 1},
				{FFmpegIndex: 4, Channels: 1},
			},
			wantStreamIndex:   1,
			wantChannelStream: 0,
		},
		{
			name:         "4 mono streams - channel 2",
			channelIndex: 2,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 1},
				{FFmpegIndex: 2, Channels: 1},
				{FFmpegIndex: 3, Channels: 1},
				{FFmpegIndex: 4, Channels: 1},
			},
			wantStreamIndex:   2,
			wantChannelStream: 0,
		},
		{
			name:         "4 mono streams - channel 3",
			channelIndex: 3,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 1},
				{FFmpegIndex: 2, Channels: 1},
				{FFmpegIndex: 3, Channels: 1},
				{FFmpegIndex: 4, Channels: 1},
			},
			wantStreamIndex:   3,
			wantChannelStream: 0,
		},
		{
			name:         "4 mono streams - out of bounds",
			channelIndex: 4,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 1},
				{FFmpegIndex: 2, Channels: 1},
				{FFmpegIndex: 3, Channels: 1},
				{FFmpegIndex: 4, Channels: 1},
			},
			wantErr: true,
		},
		{
			name:         "single quad stream - channel 2",
			channelIndex: 2,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 4},
			},
			wantStreamIndex:   0,
			wantChannelStream: 2,
		},
		{
			name:         "dual stereo streams - channel 3",
			channelIndex: 3,
			audioStreams: []AudioStream{
				{FFmpegIndex: 1, Channels: 2},
				{FFmpegIndex: 2, Channels: 2},
			},
			wantStreamIndex:   1,
			wantChannelStream: 1,
		},
		{
			name:         "empty streams list",
			channelIndex: 0,
			audioStreams: []AudioStream{},
			wantErr:      true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStream, gotChan, err := resolveAudioStreamAndChannel(tt.channelIndex, tt.audioStreams)
			if (err != nil) != tt.wantErr {
				t.Fatalf("unexpected error state: %v, wantErr: %v", err, tt.wantErr)
			}
			if !tt.wantErr {
				if gotStream != tt.wantStreamIndex {
					t.Errorf("got streamIndex %d, want %d", gotStream, tt.wantStreamIndex)
				}
				if gotChan != tt.wantChannelStream {
					t.Errorf("got channelInStream %d, want %d", gotChan, tt.wantChannelStream)
				}
			}
		})
	}
}
