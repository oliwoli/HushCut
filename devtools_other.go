//go:build !darwin || !devtools

package main

import "unsafe"

func enableNativeDevTools(nativeWindow unsafe.Pointer) {}
func openNativeDevTools(nativeWindow unsafe.Pointer) {}
