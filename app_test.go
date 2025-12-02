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
