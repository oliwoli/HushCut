package main

import "testing"

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		current string
		latest  string
		want    bool
	}{
		// Basic upgrades
		{"v0.3.4", "v0.4.0", true},
		{"0.3.4", "0.4.0", true},
		{"v0.4.0", "v0.4.1", true},
		{"v0.4.0", "v1.0.0", true},

		// Same version
		{"v0.4.0", "v0.4.0", false},
		{"0.4.0", "v0.4.0", false},
		{"v0.4.0", "0.4.0", false},

		// Current is newer
		{"v0.4.1", "v0.4.0", false},
		{"v1.0.0", "v0.9.9", false},

		// Prerelease comparisons
		{"v0.4.0-beta.1", "v0.4.0", true},        // Stable is newer than its prerelease
		{"v0.4.0", "v0.4.0-beta.1", false},       // Prerelease is not newer than stable
		{"v0.4.0-alpha.1", "v0.4.0-beta.1", true}, // Newer prerelease
		{"v0.4.0-beta.2", "v0.4.0-beta.1", false},
		{"v0.4.0-beta.1", "v0.4.1-beta.1", true}, // Higher patch version prerelease
	}

	for _, tt := range tests {
		t.Run(tt.current+"_vs_"+tt.latest, func(t *testing.T) {
			got := isNewerVersion(tt.current, tt.latest)
			if got != tt.want {
				t.Errorf("isNewerVersion(%q, %q) = %v; want %v", tt.current, tt.latest, got, tt.want)
			}
		})
	}
}
