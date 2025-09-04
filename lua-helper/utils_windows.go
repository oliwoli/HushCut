//go:build windows

package main

import "syscall"

func detachConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("FreeConsole")
	proc.Call()
}
