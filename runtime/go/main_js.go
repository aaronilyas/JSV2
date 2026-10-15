//go:build js && wasm

package main

import "syscall/js"

func main() {
	registerRuntime()
	ready := js.Global().Get("__jsvWasmReady")
	if ready.Truthy() {
		ready.Invoke()
	}
	// Keep the module alive for JS callbacks.
	select {}
}
