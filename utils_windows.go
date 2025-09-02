//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// ExecCommand is a drop-in replacement for exec.Command with hidden windows on Windows.
func ExecCommand(name string, arg ...string) *exec.Cmd {
	cmd := exec.Command(name, arg...)

	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}

	return cmd
}
