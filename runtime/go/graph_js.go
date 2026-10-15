//go:build js && wasm

package main

import (
	"strings"
	"syscall/js"
)

const (
	kindSignal   = 1
	kindComputed = 2
	kindEffect   = 3
)

type graphNode struct {
	kind int

	value    js.Value
	hasValue bool

	subscribers map[int]struct{}

	fn         js.Value
	dirty      bool
	computing  bool
	deps       map[int]struct{}
	cleanup    js.Value
	hasCleanup bool
	disposed   bool
}

var (
	nodes       []*graphNode
	active      int = -1
	effectQueue []int
	flushing    bool
	objectIs    js.Value
	cycleMsg    = "jsv.runtime.cycle: computed depends on itself"
)

func initGraph() {
	objectIs = js.Global().Get("Object").Get("is")
	nodes = make([]*graphNode, 0, 64)
}

func cycleError() js.Value {
	obj := js.Global().Get("Object").New()
	obj.Set("__jsv_cycle__", cycleMsg)
	return obj
}

func isCycleError(v js.Value) bool {
	return v.Type() == js.TypeObject && v.Get("__jsv_cycle__").Truthy()
}

func link(depID int) {
	if active < 0 {
		return
	}
	dep := nodes[depID]
	if dep.subscribers == nil {
		dep.subscribers = make(map[int]struct{})
	}
	dep.subscribers[active] = struct{}{}
	act := nodes[active]
	if act.deps == nil {
		act.deps = make(map[int]struct{})
	}
	act.deps[depID] = struct{}{}
}

func clearDeps(id int) {
	n := nodes[id]
	for depID := range n.deps {
		delete(nodes[depID].subscribers, id)
	}
	n.deps = make(map[int]struct{})
}

func markDirty(id int) {
	n := nodes[id]
	if n.kind == kindComputed {
		if n.dirty {
			return
		}
		n.dirty = true
		for sub := range n.subscribers {
			markDirty(sub)
		}
		return
	}
	if n.kind == kindEffect {
		if n.disposed || n.dirty {
			return
		}
		n.dirty = true
		effectQueue = append(effectQueue, id)
	}
}

func notify(depID int) {
	subs := make([]int, 0, len(nodes[depID].subscribers))
	for sub := range nodes[depID].subscribers {
		subs = append(subs, sub)
	}
	for _, sub := range subs {
		markDirty(sub)
	}
	flushEffects()
}

func runEffect(id int) {
	n := nodes[id]
	if n.disposed {
		return
	}
	if n.hasCleanup {
		cleanup := n.cleanup
		n.hasCleanup = false
		n.cleanup = js.Undefined()
		cleanup.Invoke()
	}
	clearDeps(id)
	n.dirty = false
	prev := active
	active = id
	defer func() { active = prev }()
	result := n.fn.Invoke()
	if result.Type() == js.TypeFunction {
		n.cleanup = result
		n.hasCleanup = true
	}
}

func flushEffects() {
	if flushing {
		return
	}
	flushing = true
	defer func() { flushing = false }()
	for len(effectQueue) > 0 {
		id := effectQueue[0]
		effectQueue = effectQueue[1:]
		n := nodes[id]
		if n.disposed || !n.dirty {
			continue
		}
		runEffect(id)
	}
}

// recompute evaluates the computed. Returns true when a cycle is detected
// (either locally or via a JS throw from a nested computed.get).
func recompute(id int) (cycle bool) {
	n := nodes[id]
	if n.computing {
		return true
	}
	clearDeps(id)
	n.computing = true
	n.dirty = false
	prev := active
	active = id
	defer func() {
		active = prev
		n.computing = false
	}()

	var result js.Value
	var invokeErr any
	func() {
		defer func() { invokeErr = recover() }()
		result = n.fn.Invoke()
	}()
	if invokeErr != nil {
		if err, ok := invokeErr.(js.Error); ok {
			if strings.Contains(err.Error(), "jsv.runtime.cycle") {
				return true
			}
		}
		panic(invokeErr)
	}
	if isCycleError(result) {
		return true
	}
	n.value = result
	n.hasValue = true
	return false
}

func signalNew(this js.Value, args []js.Value) any {
	n := &graphNode{
		kind:        kindSignal,
		value:       args[0],
		hasValue:    true,
		subscribers: make(map[int]struct{}),
	}
	id := len(nodes)
	nodes = append(nodes, n)
	return id
}

func signalGet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	link(id)
	return nodes[id].value
}

func signalSet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	value := args[1]
	n := nodes[id]
	if objectIs.Invoke(n.value, value).Bool() {
		return nil
	}
	n.value = value
	notify(id)
	return nil
}

func computedNew(this js.Value, args []js.Value) any {
	n := &graphNode{
		kind:        kindComputed,
		fn:          args[0],
		dirty:       true,
		deps:        make(map[int]struct{}),
		subscribers: make(map[int]struct{}),
	}
	id := len(nodes)
	nodes = append(nodes, n)
	return id
}

func computedGet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodes[id]
	link(id)
	if n.dirty || !n.hasValue {
		if recompute(id) {
			return cycleError()
		}
	}
	return n.value
}

func effectNew(this js.Value, args []js.Value) any {
	n := &graphNode{
		kind:  kindEffect,
		fn:    args[0],
		dirty: true,
		deps:  make(map[int]struct{}),
	}
	id := len(nodes)
	nodes = append(nodes, n)
	runEffect(id)
	return id
}

func effectDispose(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodes[id]
	if n.disposed {
		return nil
	}
	n.disposed = true
	n.dirty = false
	if n.hasCleanup {
		cleanup := n.cleanup
		n.hasCleanup = false
		n.cleanup = js.Undefined()
		cleanup.Invoke()
	}
	clearDeps(id)
	return nil
}

func reconcileJS(this js.Value, args []js.Value) any {
	prevVal := args[0]
	nextVal := args[1]
	prevLen := prevVal.Length()
	nextLen := nextVal.Length()
	prev := make([]string, prevLen)
	next := make([]string, nextLen)
	for i := 0; i < prevLen; i++ {
		prev[i] = prevVal.Index(i).String()
	}
	for i := 0; i < nextLen; i++ {
		next[i] = nextVal.Index(i).String()
	}
	reuse, removed := Reconcile(prev, next)

	arr := js.Global().Get("Array")
	reuseArr := arr.New(len(reuse))
	for i, v := range reuse {
		reuseArr.SetIndex(i, v)
	}
	removedArr := arr.New(len(removed))
	for i, v := range removed {
		removedArr.SetIndex(i, v)
	}
	obj := js.Global().Get("Object").New()
	obj.Set("reuse", reuseArr)
	obj.Set("removed", removedArr)
	return obj
}

func escapeXmlJS(this js.Value, args []js.Value) any {
	return EscapeXML(args[0].String())
}

func backend(this js.Value, args []js.Value) any {
	return "wasm"
}

func registerRuntime() {
	initGraph()
	obj := js.Global().Get("Object").New()
	obj.Set("backend", js.FuncOf(backend))
	obj.Set("signalNew", js.FuncOf(signalNew))
	obj.Set("signalGet", js.FuncOf(signalGet))
	obj.Set("signalSet", js.FuncOf(signalSet))
	obj.Set("computedNew", js.FuncOf(computedNew))
	obj.Set("computedGet", js.FuncOf(computedGet))
	obj.Set("effectNew", js.FuncOf(effectNew))
	obj.Set("effectDispose", js.FuncOf(effectDispose))
	obj.Set("reconcile", js.FuncOf(reconcileJS))
	obj.Set("escapeXml", js.FuncOf(escapeXmlJS))
	js.Global().Set("jsvRuntime", obj)
}
