//go:build js && wasm

package main

import (
	"fmt"
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

	// subscribers is insertion-ordered. Go maps randomize iteration; the JS
	// graph this replaced used Set, so effects on one signal must run in
	// subscription order.
	subscribers idSet

	fn         js.Value
	dirty      bool
	computing  bool
	deps       idSet
	cleanup    js.Value
	hasCleanup bool
	disposed   bool

	// unreachable is set when the JS wrapper has been collected.
	// The node is freed once nothing in the graph still observes it.
	unreachable bool
	// deferFree delays release while this node is the active reader.
	deferFree bool
}

var (
	nodes       []*graphNode
	freeIDs     []int
	active      int = -1
	effectQueue []int
	queueHead   int
	flushing    bool
	objectIs    js.Value
	pendingErr  js.Value
	hasPending  bool
	cycleMsg    = "jsv.runtime.cycle: computed depends on itself"
)

func initGraph() {
	objectIs = js.Global().Get("Object").Get("is")
	nodes = make([]*graphNode, 0, 64)
	freeIDs = nil
	effectQueue = nil
	queueHead = 0
	active = -1
	flushing = false
	hasPending = false
	pendingErr = js.Undefined()
}

func cycleError() js.Value {
	obj := js.Global().Get("Object").New()
	obj.Set("__jsv_cycle__", cycleMsg)
	return obj
}

func isCycleError(v js.Value) bool {
	return v.Type() == js.TypeObject && v.Get("__jsv_cycle__").Truthy()
}

func isCycleValue(v js.Value) bool {
	if v.Type() != js.TypeObject {
		return false
	}
	msg := v.Get("message")
	if msg.Type() != js.TypeString {
		return false
	}
	return strings.Contains(msg.String(), "jsv.runtime.cycle")
}

type jsCall struct {
	value js.Value
	err   js.Value
	threw bool
}

// callJS runs a user callback. A thrown JS value becomes a Go panic inside
// Invoke; recovering here keeps the WASM instance alive so the host can
// rethrow the same value to the caller.
func callJS(fn js.Value) (call jsCall) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		call.threw = true
		call.value = js.Undefined()
		if e, ok := r.(js.Error); ok {
			call.err = e.Value
			return
		}
		call.err = js.Global().Get("Error").New(fmt.Sprint(r))
	}()
	call.value = fn.Invoke()
	return call
}

func setPending(err js.Value) {
	if hasPending {
		return
	}
	pendingErr = err
	hasPending = true
}

func nodeAt(id int) *graphNode {
	if id < 0 || id >= len(nodes) {
		return nil
	}
	return nodes[id]
}

func allocNode(n *graphNode) int {
	if len(freeIDs) > 0 {
		id := freeIDs[len(freeIDs)-1]
		freeIDs = freeIDs[:len(freeIDs)-1]
		nodes[id] = n
		return id
	}
	id := len(nodes)
	nodes = append(nodes, n)
	return id
}

func link(depID int) {
	if active < 0 {
		return
	}
	act := nodeAt(active)
	dep := nodeAt(depID)
	if act == nil || dep == nil {
		return
	}
	dep.subscribers.add(active)
	act.deps.add(depID)
}

func maybeFree(id int) {
	n := nodeAt(id)
	if n == nil || !n.unreachable || id == active {
		return
	}
	if n.kind == kindEffect || n.subscribers.len() > 0 {
		return
	}
	freeSlot(id)
}

func clearDeps(id int) {
	n := nodeAt(id)
	if n == nil {
		return
	}
	deps := n.deps.snapshot()
	n.deps.clear()
	for _, depID := range deps {
		dep := nodeAt(depID)
		if dep == nil {
			continue
		}
		dep.subscribers.remove(id)
		maybeFree(depID)
	}
}

func removeFromQueue(id int) {
	if queueHead >= len(effectQueue) {
		effectQueue = effectQueue[:0]
		queueHead = 0
		return
	}
	next := make([]int, 0, len(effectQueue)-queueHead)
	for i := queueHead; i < len(effectQueue); i++ {
		if effectQueue[i] != id {
			next = append(next, effectQueue[i])
		}
	}
	effectQueue = next
	queueHead = 0
}

func dequeueEffect() (int, bool) {
	if queueHead >= len(effectQueue) {
		effectQueue = effectQueue[:0]
		queueHead = 0
		return 0, false
	}
	id := effectQueue[queueHead]
	queueHead++
	if queueHead == len(effectQueue) {
		effectQueue = effectQueue[:0]
		queueHead = 0
	}
	return id, true
}

func enqueueEffect(id int) {
	effectQueue = append(effectQueue, id)
}

// freeSlot drops a node and returns its id to the free list.
// JS values on the node are cleared so the closures they pin can be collected
// once the Go GC finalizes those refs.
func freeSlot(id int) {
	n := nodeAt(id)
	if n == nil {
		return
	}
	if id == active {
		n.deferFree = true
		return
	}
	deps := n.deps.snapshot()
	subs := n.subscribers.snapshot()
	n.deps.clear()
	n.subscribers.clear()
	for _, depID := range deps {
		if dep := nodeAt(depID); dep != nil {
			dep.subscribers.remove(id)
			maybeFree(depID)
		}
	}
	for _, subID := range subs {
		if sub := nodeAt(subID); sub != nil {
			sub.deps.remove(id)
		}
	}
	removeFromQueue(id)
	n.fn = js.Undefined()
	n.value = js.Undefined()
	n.cleanup = js.Undefined()
	n.hasCleanup = false
	n.disposed = true
	n.deferFree = false
	nodes[id] = nil
	freeIDs = append(freeIDs, id)
}

func markDirty(id int) {
	n := nodeAt(id)
	if n == nil {
		return
	}
	if n.kind == kindComputed {
		if n.dirty {
			return
		}
		n.dirty = true
		subs := n.subscribers.snapshot()
		for _, sub := range subs {
			markDirty(sub)
		}
		return
	}
	if n.kind == kindEffect {
		if n.disposed || n.dirty {
			return
		}
		n.dirty = true
		enqueueEffect(id)
	}
}

func notify(depID int) jsCall {
	n := nodeAt(depID)
	if n == nil {
		return jsCall{}
	}
	subs := n.subscribers.snapshot()
	for _, sub := range subs {
		markDirty(sub)
	}
	return flushEffects()
}

func runEffect(id int) jsCall {
	n := nodeAt(id)
	if n == nil || n.disposed {
		return jsCall{}
	}
	prev := active
	active = id
	defer func() {
		active = prev
		if cur := nodeAt(id); cur != nil && cur.deferFree {
			freeSlot(id)
		}
	}()

	if n.hasCleanup {
		cleanup := n.cleanup
		n.hasCleanup = false
		n.cleanup = js.Undefined()
		if call := callJS(cleanup); call.threw {
			// Leave the effect dirty and dequeued so a throwing cleanup does
			// not run again on every later flush, and does not drop the rest
			// of the queue's chance to run on the next flush.
			return call
		}
	}
	if n.disposed {
		return jsCall{}
	}
	clearDeps(id)
	n.dirty = false
	call := callJS(n.fn)
	if call.threw || n.disposed {
		return call
	}
	if call.value.Type() == js.TypeFunction {
		n.cleanup = call.value
		n.hasCleanup = true
	}
	return jsCall{}
}

func flushEffects() jsCall {
	if flushing {
		return jsCall{}
	}
	flushing = true
	defer func() { flushing = false }()
	for {
		id, ok := dequeueEffect()
		if !ok {
			return jsCall{}
		}
		n := nodeAt(id)
		if n == nil || n.disposed || !n.dirty {
			continue
		}
		if call := runEffect(id); call.threw {
			return call
		}
	}
}

// recompute evaluates the computed. cycle is true when a cycle is detected.
// call.threw is a user exception, which is not a cycle.
func recompute(id int) (cycle bool, call jsCall) {
	n := nodeAt(id)
	if n == nil {
		return false, jsCall{}
	}
	if n.computing {
		return true, jsCall{}
	}
	clearDeps(id)
	n.computing = true
	n.dirty = false
	prev := active
	active = id
	defer func() {
		active = prev
		n.computing = false
		if cur := nodeAt(id); cur != nil && cur.deferFree {
			freeSlot(id)
		}
	}()

	call = callJS(n.fn)
	if call.threw {
		if isCycleValue(call.err) {
			return true, jsCall{}
		}
		// Leave dirty false so the next dependency change propagates to
		// subscribers. hasValue stays false when this computed never succeeded,
		// so the next get retries.
		return false, call
	}
	if isCycleError(call.value) {
		return true, jsCall{}
	}
	n.value = call.value
	n.hasValue = true
	return false, jsCall{}
}

func signalNew(this js.Value, args []js.Value) any {
	initial := js.Undefined()
	if len(args) > 0 {
		initial = args[0]
	}
	n := &graphNode{
		kind:     kindSignal,
		value:    initial,
		hasValue: true,
	}
	return allocNode(n)
}

func signalGet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodeAt(id)
	if n == nil {
		return js.Undefined()
	}
	link(id)
	return n.value
}

func signalSet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodeAt(id)
	if n == nil {
		return nil
	}
	value := args[1]
	if objectIs.Invoke(n.value, value).Bool() {
		return nil
	}
	n.value = value
	if call := notify(id); call.threw {
		setPending(call.err)
	}
	return nil
}

func computedNew(this js.Value, args []js.Value) any {
	n := &graphNode{
		kind:  kindComputed,
		fn:    args[0],
		dirty: true,
	}
	return allocNode(n)
}

func computedGet(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodeAt(id)
	if n == nil {
		return js.Undefined()
	}
	link(id)
	if n.dirty || !n.hasValue {
		cycle, call := recompute(id)
		if call.threw {
			setPending(call.err)
			return nil
		}
		if cycle {
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
	}
	id := allocNode(n)
	if call := runEffect(id); call.threw {
		setPending(call.err)
		// Nothing subscribed, so a later update cannot rerun it, and the caller
		// does not receive a disposer when effect() throws.
		if cur := nodeAt(id); cur != nil && cur.deps.len() == 0 {
			freeSlot(id)
		}
	}
	return id
}

func effectDispose(this js.Value, args []js.Value) any {
	id := args[0].Int()
	n := nodeAt(id)
	if n == nil || n.kind != kindEffect {
		return nil
	}
	var call jsCall
	if !n.disposed {
		n.disposed = true
		n.dirty = false
		removeFromQueue(id)
		var cleanup js.Value
		hasCleanup := n.hasCleanup
		if hasCleanup {
			cleanup = n.cleanup
			n.hasCleanup = false
			n.cleanup = js.Undefined()
		}
		clearDeps(id)
		if hasCleanup {
			call = callJS(cleanup)
		}
	}
	freeSlot(id)
	if call.threw {
		setPending(call.err)
	}
	return nil
}

// releaseNodeJS is the FinalizationRegistry hook. Effects are released by
// dispose; signals and computeds are freed once no subscriber still reads them.
func releaseNodeJS(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	id := args[0].Int()
	n := nodeAt(id)
	if n == nil {
		return nil
	}
	n.unreachable = true
	maybeFree(id)
	return nil
}

func nodeStatsJS(this js.Value, args []js.Value) any {
	live := 0
	for _, n := range nodes {
		if n != nil {
			live++
		}
	}
	obj := js.Global().Get("Object").New()
	obj.Set("live", live)
	obj.Set("capacity", len(nodes))
	obj.Set("free", len(freeIDs))
	return obj
}

func takePendingJS(this js.Value, args []js.Value) any {
	obj := js.Global().Get("Object").New()
	if !hasPending {
		obj.Set("threw", false)
		obj.Set("error", js.Undefined())
		return obj
	}
	obj.Set("threw", true)
	obj.Set("error", pendingErr)
	pendingErr = js.Undefined()
	hasPending = false
	return obj
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

// exportFn turns a panic inside a JS-called Go function into a pending error
// instead of exiting the Go program. User callbacks are recovered in callJS;
// this is the backstop for anything that still escapes.
func exportFn(fn func(this js.Value, args []js.Value) any) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) (result any) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			result = nil
			if hasPending {
				return
			}
			if e, ok := r.(js.Error); ok {
				setPending(e.Value)
				return
			}
			setPending(js.Global().Get("Error").New(fmt.Sprint(r)))
		}()
		result = fn(this, args)
		return result
	})
}

func registerRuntime() {
	initGraph()
	obj := js.Global().Get("Object").New()
	obj.Set("backend", exportFn(backend))
	obj.Set("signalNew", exportFn(signalNew))
	obj.Set("signalGet", exportFn(signalGet))
	obj.Set("signalSet", exportFn(signalSet))
	obj.Set("computedNew", exportFn(computedNew))
	obj.Set("computedGet", exportFn(computedGet))
	obj.Set("effectNew", exportFn(effectNew))
	obj.Set("effectDispose", exportFn(effectDispose))
	obj.Set("releaseNode", exportFn(releaseNodeJS))
	obj.Set("nodeStats", exportFn(nodeStatsJS))
	obj.Set("takePending", exportFn(takePendingJS))
	obj.Set("reconcile", exportFn(reconcileJS))
	obj.Set("escapeXml", exportFn(escapeXmlJS))
	js.Global().Set("jsvRuntime", obj)
}
