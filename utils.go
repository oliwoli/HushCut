//go:build !windows

package main

import (
	"os/exec"
)

// ExecCommand is a drop-in replacement for exec.Command with hidden windows on Windows.
func ExecCommand(name string, arg ...string) *exec.Cmd {
	cmd := exec.Command(name, arg...)
	return cmd
}
