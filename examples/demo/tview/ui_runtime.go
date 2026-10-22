// Runtime of the program API of a TUI Studio export (see docs/PROGRAM_API.md).
//
// This file is generated and identical for every Go export - do not edit it, edit your own
// program instead. It has no dependency on a UI framework: the framework adapter implements the
// small Renderer interface and the rest (store, states, events, errors, log, lifecycle, typed
// handles) lives here.
//
//	ui := NewUi()
//	ui.Start()                              // the UI runs concurrently, Start returns when it is ready
//	ui.SubmitBtn.OnClick(func(e Event) {})  // events (handlers run on their own goroutine)
//	ui.Status.SetText("Ready")              // properties (writing never fires an event)
//	ui.NameInput.Readonly()                 // states: Active / Mute / Readonly / Hide
//	ui.Report(errors.New("lost"))           // error dialog + log
//	ui.Wait()                               // block until the UI is closed
//
// Every call is safe from any goroutine and returns immediately.

package main

import (
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// Renderer is what the framework adapter provides. Both methods must be safe to call from any
// goroutine and must not block.
type Renderer interface {
	// Refresh asks the UI to redraw from the store soon.
	Refresh()
	// Stop closes the UI.
	Stop()
}

// State of a component.
type State string

const (
	StateActive   State = "active"
	StateMuted    State = "muted"
	StateReadonly State = "readonly"
	StateHidden   State = "hidden"
)

// States a component type supports.
var (
	StatesAll        = []State{StateActive, StateMuted, StateReadonly, StateHidden}
	StatesNoReadonly = []State{StateActive, StateMuted, StateHidden}
	StatesHideOnly   = []State{StateActive, StateHidden}
)

// Event is a user interaction: which component, what happened and its value.
type Event struct {
	Tag   string
	Name  string
	Value any
	Time  time.Time
}

// ErrorEntry is an error or a log line.
type ErrorEntry struct {
	Time    time.Time
	Level   string // debug, info, warning, error, critical
	Message string
	Details string
	Source  string
}

func (e ErrorEntry) String() string {
	return e.Time.Format("15:04:05") + " " + strings.ToUpper(e.Level) + " " + e.Message
}

// ── Store ─────────────────────────────────────────────────────────────────────

// Core owns the state of the UI (one Comp per component), the events, the errors and the log.
type Core struct {
	mu       sync.Mutex
	cond     *sync.Cond
	comps    map[string]*Comp
	renderer Renderer
	started  bool
	ready    bool
	closed   bool
	readyCh  chan struct{}
	doneCh   chan struct{}
	queue    chan Event
	jobs     []func()
	errs     []ErrorEntry
	seen     int
	logs     []ErrorEntry
	logOn    bool

	// Log writes to the log panel (Ctrl+L).
	Log *LogApi
}

// NewCore creates the store and starts the goroutine that runs event handlers.
func NewCore() *Core {
	c := &Core{
		comps:   map[string]*Comp{},
		readyCh: make(chan struct{}),
		doneCh:  make(chan struct{}),
		queue:   make(chan Event, 1024),
	}
	c.cond = sync.NewCond(&c.mu)
	c.Log = &LogApi{core: c}
	go c.dispatch()
	return c
}

// Comp is the state of one component: its state and its properties.
type Comp struct {
	core     *Core
	tag      string
	kind     string
	public   bool
	states   []State
	state    State
	props    map[string]any
	ver      uint64
	handlers map[string][]func(Event)
}

// Define registers a component. Tags that start with "~" are internal (components without a
// code name): they are stored like all others but are not part of the API and emit no events.
func (c *Core) Define(tag, kind string, states []State, initial State, props map[string]any) *Comp {
	c.mu.Lock()
	defer c.mu.Unlock()
	comp := &Comp{
		core:     c,
		tag:      tag,
		kind:     kind,
		public:   !strings.HasPrefix(tag, "~"),
		states:   states,
		state:    initial,
		props:    map[string]any{},
		ver:      1,
		handlers: map[string][]func(Event){},
	}
	for k, v := range props {
		comp.props[k] = cloneValue(v)
	}
	c.comps[tag] = comp
	return comp
}

// Comp returns the component with this tag (nil if there is none).
func (c *Core) Comp(tag string) *Comp {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.comps[tag]
}

func cloneValue(v any) any {
	switch x := v.(type) {
	case []string:
		return append([]string(nil), x...)
	case [][]string:
		out := make([][]string, len(x))
		for i, r := range x {
			out[i] = append([]string(nil), r...)
		}
		return out
	}
	return v
}

// Tag is the code name.
func (p *Comp) Tag() string { return p.tag }

// Public reports whether the component is part of the API (it has a code name).
func (p *Comp) Public() bool { return p.public }

// Version changes on every write; the UI uses it to notice changes cheaply.
func (p *Comp) Version() uint64 {
	p.core.mu.Lock()
	defer p.core.mu.Unlock()
	return p.ver
}

// State returns the current state.
func (p *Comp) State() State {
	p.core.mu.Lock()
	defer p.core.mu.Unlock()
	return p.state
}

// SetState changes the state; a state the component does not support is an error.
func (p *Comp) SetState(s State) error {
	p.core.mu.Lock()
	ok := false
	for _, st := range p.states {
		if st == s {
			ok = true
		}
	}
	if !ok {
		p.core.mu.Unlock()
		return fmt.Errorf("%s %q does not support the state %q", p.kind, p.tag, string(s))
	}
	p.state = s
	p.ver++
	p.core.mu.Unlock()
	p.core.refresh()
	return nil
}

// Get returns a property (nil if it does not exist).
func (p *Comp) Get(name string) any {
	p.core.mu.Lock()
	defer p.core.mu.Unlock()
	return cloneValue(p.props[name])
}

func (p *Comp) Str(name string) string {
	s, _ := p.Get(name).(string)
	return s
}

func (p *Comp) Int(name string) int {
	switch v := p.Get(name).(type) {
	case int:
		return v
	case float64:
		return int(v)
	}
	return 0
}

func (p *Comp) Float(name string) float64 {
	switch v := p.Get(name).(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}

func (p *Comp) Bool(name string) bool {
	b, _ := p.Get(name).(bool)
	return b
}

func (p *Comp) List(name string) []string {
	l, _ := p.Get(name).([]string)
	return l
}

func (p *Comp) Rows(name string) [][]string {
	r, _ := p.Get(name).([][]string)
	return r
}

func (p *Comp) put(name string, v any) {
	p.core.mu.Lock()
	p.props[name] = cloneValue(v)
	p.ver++
	p.core.mu.Unlock()
}

// Set writes a property from the program and redraws. It never fires an event.
func (p *Comp) Set(name string, v any) {
	p.put(name, v)
	p.core.refresh()
}

// UserSet writes a property on behalf of the user (the UI already shows it, no redraw request).
func (p *Comp) UserSet(name string, v any) { p.put(name, v) }

// On registers a handler for an event; handlers run on their own goroutine.
func (p *Comp) On(name string, fn func(Event)) {
	if fn == nil {
		return
	}
	p.core.mu.Lock()
	p.handlers[name] = append(p.handlers[name], fn)
	p.core.mu.Unlock()
}

// Emit reports a user interaction: it runs the handlers and queues the event. Components that
// are muted, readonly or hidden, and components without a code name, send nothing.
func (p *Comp) Emit(name string, value any) bool {
	c := p.core
	c.mu.Lock()
	if p.state != StateActive || !p.public || c.closed {
		c.mu.Unlock()
		return false
	}
	ev := Event{Tag: p.tag, Name: name, Value: value, Time: time.Now()}
	hs := append([]func(Event){}, p.handlers[name]...)
	c.jobs = append(c.jobs, func() {
		for _, h := range hs {
			c.callHandler(h, ev)
		}
	})
	c.cond.Signal()
	c.mu.Unlock()
	select {
	case c.queue <- ev:
	default:
	}
	return true
}

// ── Events, errors, log ───────────────────────────────────────────────────────

func (c *Core) callHandler(h func(Event), ev Event) {
	defer func() {
		if r := recover(); r != nil {
			c.add("error", fmt.Sprintf("panic in the %s handler of %s: %v", ev.Name, ev.Tag, r), string(debug.Stack()), ev.Tag+"."+ev.Name)
		}
	}()
	h(ev)
}

// dispatch runs handlers one after the other, never on the UI goroutine.
func (c *Core) dispatch() {
	for {
		c.mu.Lock()
		for len(c.jobs) == 0 && !c.closed {
			c.cond.Wait()
		}
		if len(c.jobs) == 0 {
			c.mu.Unlock()
			return
		}
		job := c.jobs[0]
		c.jobs = c.jobs[1:]
		c.mu.Unlock()
		job()
	}
}

// Defer runs fn on the handler goroutine (panics are reported).
func (c *Core) Defer(fn func()) {
	c.mu.Lock()
	c.jobs = append(c.jobs, func() {
		defer func() {
			if r := recover(); r != nil {
				c.add("error", fmt.Sprintf("panic in a handler: %v", r), string(debug.Stack()), "handler")
			}
		}()
		fn()
	})
	c.cond.Signal()
	c.mu.Unlock()
}

// Events is the queue of all events (a program can run its own loop on it). It holds up to 1024
// events; further ones are only delivered to handlers.
func (c *Core) Events() <-chan Event { return c.queue }

// NextEvent waits for the next event: timeout < 0 waits until the UI closes, 0 only polls.
func (c *Core) NextEvent(timeout time.Duration) (Event, bool) {
	if timeout == 0 {
		select {
		case ev := <-c.queue:
			return ev, true
		default:
			return Event{}, false
		}
	}
	if timeout < 0 {
		select {
		case ev := <-c.queue:
			return ev, true
		case <-c.doneCh:
			return Event{}, false
		}
	}
	select {
	case ev := <-c.queue:
		return ev, true
	case <-time.After(timeout):
		return Event{}, false
	}
}

// Report opens the error dialog, adds the error to Errors() and to the log. It accepts an
// error, a string or anything printable.
func (c *Core) Report(v any) {
	msg, details := "", ""
	switch x := v.(type) {
	case nil:
		msg = "unknown error"
	case error:
		msg = x.Error()
		details = fmt.Sprintf("%+v", x)
	case string:
		msg = x
	default:
		msg = fmt.Sprint(x)
	}
	c.add("error", msg, details, "")
}

func (c *Core) add(level, msg, details, source string) {
	e := ErrorEntry{Time: time.Now(), Level: level, Message: msg, Details: details, Source: source}
	c.mu.Lock()
	c.errs = append(c.errs, e)
	c.appendLog(e)
	c.mu.Unlock()
	c.refresh()
}

func (c *Core) appendLog(e ErrorEntry) {
	c.logs = append(c.logs, e)
	if len(c.logs) > 500 {
		c.logs = c.logs[len(c.logs)-500:]
	}
}

// Errors returns every reported error.
func (c *Core) Errors() []ErrorEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ErrorEntry(nil), c.errs...)
}

// UnseenErrors are the errors the dialog still has to show.
func (c *Core) UnseenErrors() []ErrorEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ErrorEntry(nil), c.errs[c.seen:]...)
}

// MarkErrorsSeen closes the error dialog.
func (c *Core) MarkErrorsSeen() {
	c.mu.Lock()
	c.seen = len(c.errs)
	c.mu.Unlock()
	c.refresh()
}

// LogEntries returns the log (the last 500 lines).
func (c *Core) LogEntries() []ErrorEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]ErrorEntry(nil), c.logs...)
}

// LogVisible reports whether the log panel is shown.
func (c *Core) LogVisible() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.logOn
}

// ToggleLog shows or hides the log panel (Ctrl+L).
func (c *Core) ToggleLog() {
	c.mu.Lock()
	c.logOn = !c.logOn
	c.mu.Unlock()
	c.refresh()
}

// LogApi is ui.Log.
type LogApi struct{ core *Core }

func (l *LogApi) write(level string, args []any) {
	e := ErrorEntry{Time: time.Now(), Level: level, Message: strings.TrimSuffix(fmt.Sprintln(args...), "\n")}
	l.core.mu.Lock()
	l.core.appendLog(e)
	l.core.mu.Unlock()
	l.core.refresh()
}

func (l *LogApi) Debug(args ...any)   { l.write("debug", args) }
func (l *LogApi) Info(args ...any)    { l.write("info", args) }
func (l *LogApi) Warning(args ...any) { l.write("warning", args) }
func (l *LogApi) Error(args ...any)   { l.write("error", args) }

// CatchPanics runs fn and reports a panic as an error instead of crashing the program:
// go ui.CatchPanics(func() { ... }).
func (c *Core) CatchPanics(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			c.add("critical", fmt.Sprintf("panic: %v", r), string(debug.Stack()), "program")
		}
	}()
	fn()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Attach connects the framework adapter.
func (c *Core) Attach(r Renderer) {
	c.mu.Lock()
	c.renderer = r
	c.mu.Unlock()
}

// Renderer returns what Attach was given.
func (c *Core) Renderer() Renderer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.renderer
}

// MarkStarted is true the first time it is called (the UI can only be started once).
func (c *Core) MarkStarted() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started {
		return false
	}
	c.started = true
	return true
}

// SetReady is called by the adapter when the UI is up.
func (c *Core) SetReady() {
	c.mu.Lock()
	if !c.ready {
		c.ready = true
		close(c.readyCh)
	}
	c.mu.Unlock()
}

// MarkClosed is called by the adapter when the UI has ended.
func (c *Core) MarkClosed() {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.doneCh)
		c.cond.Broadcast()
	}
	c.mu.Unlock()
}

// Ready reports whether the UI has started.
func (c *Core) Ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready
}

// Closed reports whether the UI has ended.
func (c *Core) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// Running is true while the UI is up.
func (c *Core) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready && !c.closed
}

// Stop closes the UI.
func (c *Core) Stop() {
	c.mu.Lock()
	r := c.renderer
	c.mu.Unlock()
	if r != nil {
		r.Stop()
	} else {
		c.MarkClosed()
	}
}

// Wait blocks until the UI is closed.
func (c *Core) Wait() { <-c.doneCh }

// WaitTimeout is Wait with a limit; it reports whether the UI closed.
func (c *Core) WaitTimeout(d time.Duration) bool {
	select {
	case <-c.doneCh:
		return true
	case <-time.After(d):
		return false
	}
}

// WaitReady blocks until the UI is up (false if it closed or the time ran out).
func (c *Core) WaitReady(d time.Duration) bool {
	select {
	case <-c.readyCh:
		return true
	case <-c.doneCh:
		return false
	case <-time.After(d):
		return false
	}
}

func (c *Core) refresh() {
	c.mu.Lock()
	r, closed := c.renderer, c.closed
	c.mu.Unlock()
	if r != nil && !closed {
		r.Refresh()
	}
}

// ── Queries for the adapter ───────────────────────────────────────────────────

// Hidden reports whether the component is hidden.
func (c *Core) Hidden(tag string) bool {
	comp := c.Comp(tag)
	return comp != nil && comp.State() == StateHidden
}

// Muted reports whether the component is muted.
func (c *Core) Muted(tag string) bool {
	comp := c.Comp(tag)
	return comp != nil && comp.State() == StateMuted
}

// Open reports whether a modal is open.
func (c *Core) Open(tag string) bool {
	comp := c.Comp(tag)
	return comp != nil && comp.Bool("open")
}

// Shown is true if none of the tags is hidden and every modal among them is open.
func (c *Core) Shown(tags ...string) bool {
	for _, tag := range tags {
		comp := c.Comp(tag)
		if comp == nil {
			continue
		}
		if comp.State() == StateHidden {
			return false
		}
		if comp.Get("open") != nil && !comp.Bool("open") {
			return false
		}
	}
	return true
}

// Usable is true if the user can focus the component: it is active or readonly and its
// containers (the ancestors) are shown.
func (c *Core) Usable(tag string, ancestors ...string) bool {
	comp := c.Comp(tag)
	if comp == nil {
		return false
	}
	if st := comp.State(); st != StateActive && st != StateReadonly {
		return false
	}
	return c.Shown(ancestors...)
}

// ── Typed handles ─────────────────────────────────────────────────────────────

// Handle is what every component has: its state.
type Handle struct{ c *Comp }

func (h *Handle) Tag() string     { return h.c.tag }
func (h *Handle) State() State    { return h.c.State() }
func (h *Handle) Active() error   { return h.c.SetState(StateActive) }
func (h *Handle) Mute() error     { return h.c.SetState(StateMuted) }
func (h *Handle) Readonly() error { return h.c.SetState(StateReadonly) }
func (h *Handle) Hide() error     { return h.c.SetState(StateHidden) }
func (h *Handle) Show() error     { return h.c.SetState(StateActive) }

type ContainerHandle struct{ Handle }

func NewContainerHandle(c *Comp) *ContainerHandle { return &ContainerHandle{Handle{c}} }

type TextHandle struct{ Handle }

func NewTextHandle(c *Comp) *TextHandle { return &TextHandle{Handle{c}} }
func (h *TextHandle) Text() string      { return h.c.Str("text") }
func (h *TextHandle) SetText(v string)  { h.c.Set("text", v) }

type SpinnerHandle struct{ Handle }

func NewSpinnerHandle(c *Comp) *SpinnerHandle { return &SpinnerHandle{Handle{c}} }
func (h *SpinnerHandle) Label() string        { return h.c.Str("label") }
func (h *SpinnerHandle) SetLabel(v string)    { h.c.Set("label", v) }

type ButtonHandle struct{ Handle }

func NewButtonHandle(c *Comp) *ButtonHandle    { return &ButtonHandle{Handle{c}} }
func (h *ButtonHandle) Label() string          { return h.c.Str("label") }
func (h *ButtonHandle) SetLabel(v string)      { h.c.Set("label", v) }
func (h *ButtonHandle) OnClick(fn func(Event)) { h.c.On("click", fn) }

type InputHandle struct{ Handle }

func NewInputHandle(c *Comp) *InputHandle      { return &InputHandle{Handle{c}} }
func (h *InputHandle) Value() string           { return h.c.Str("value") }
func (h *InputHandle) SetValue(v string)       { h.c.Set("value", v) }
func (h *InputHandle) Placeholder() string     { return h.c.Str("placeholder") }
func (h *InputHandle) SetPlaceholder(v string) { h.c.Set("placeholder", v) }
func (h *InputHandle) OnChange(fn func(Event)) { h.c.On("change", fn) }
func (h *InputHandle) OnSubmit(fn func(Event)) { h.c.On("submit", fn) }

// CheckHandle serves Checkbox, Radio and Toggle.
type CheckHandle struct{ Handle }

func NewCheckHandle(c *Comp) *CheckHandle      { return &CheckHandle{Handle{c}} }
func (h *CheckHandle) Checked() bool           { return h.c.Bool("checked") }
func (h *CheckHandle) SetChecked(v bool)       { h.c.Set("checked", v) }
func (h *CheckHandle) Label() string           { return h.c.Str("label") }
func (h *CheckHandle) SetLabel(v string)       { h.c.Set("label", v) }
func (h *CheckHandle) OnChange(fn func(Event)) { h.c.On("change", fn) }

type SelectHandle struct{ Handle }

func NewSelectHandle(c *Comp) *SelectHandle     { return &SelectHandle{Handle{c}} }
func (h *SelectHandle) Value() string           { return h.c.Str("value") }
func (h *SelectHandle) SetValue(v string)       { h.c.Set("value", v) }
func (h *SelectHandle) Options() []string       { return h.c.List("options") }
func (h *SelectHandle) SetOptions(v []string)   { h.c.Set("options", v) }
func (h *SelectHandle) OnChange(fn func(Event)) { h.c.On("change", fn) }

type ProgressHandle struct{ Handle }

func NewProgressHandle(c *Comp) *ProgressHandle { return &ProgressHandle{Handle{c}} }
func (h *ProgressHandle) Value() float64        { return h.c.Float("value") }
func (h *ProgressHandle) SetValue(v float64)    { h.c.Set("value", v) }
func (h *ProgressHandle) Max() float64          { return h.c.Float("max") }
func (h *ProgressHandle) SetMax(v float64)      { h.c.Set("max", v) }

type TableHandle struct{ Handle }

func NewTableHandle(c *Comp) *TableHandle     { return &TableHandle{Handle{c}} }
func (h *TableHandle) Columns() []string      { return h.c.List("columns") }
func (h *TableHandle) SetColumns(v []string)  { h.c.Set("columns", v) }
func (h *TableHandle) Rows() [][]string       { return h.c.Rows("rows") }
func (h *TableHandle) SetRows(v [][]string)   { h.c.Set("rows", v) }
func (h *TableHandle) AddRow(cells ...string) { h.c.Set("rows", append(h.c.Rows("rows"), cells)) }
func (h *TableHandle) Clear()                 { h.c.Set("rows", [][]string{}) }

type ListHandle struct{ Handle }

func NewListHandle(c *Comp) *ListHandle       { return &ListHandle{Handle{c}} }
func (h *ListHandle) Items() []string         { return h.c.List("items") }
func (h *ListHandle) SetItems(v []string)     { h.c.Set("items", v) }
func (h *ListHandle) Selected() int           { return h.c.Int("selected") }
func (h *ListHandle) SetSelected(v int)       { h.c.Set("selected", v) }
func (h *ListHandle) OnSelect(fn func(Event)) { h.c.On("select", fn) }

type MenuHandle struct{ Handle }

func NewMenuHandle(c *Comp) *MenuHandle       { return &MenuHandle{Handle{c}} }
func (h *MenuHandle) Selected() int           { return h.c.Int("selected") }
func (h *MenuHandle) SetSelected(v int)       { h.c.Set("selected", v) }
func (h *MenuHandle) OnSelect(fn func(Event)) { h.c.On("select", fn) }

type TabsHandle struct{ Handle }

func NewTabsHandle(c *Comp) *TabsHandle       { return &TabsHandle{Handle{c}} }
func (h *TabsHandle) ActiveTab() int          { return h.c.Int("active_tab") }
func (h *TabsHandle) SetActiveTab(v int)      { h.c.Set("active_tab", v) }
func (h *TabsHandle) OnChange(fn func(Event)) { h.c.On("change", fn) }

type TreeHandle struct{ Handle }

func NewTreeHandle(c *Comp) *TreeHandle       { return &TreeHandle{Handle{c}} }
func (h *TreeHandle) OnSelect(fn func(Event)) { h.c.On("select", fn) }

// ModalHandle: a dialog shown on top of the UI; Esc closes it.
type ModalHandle struct{ Handle }

func NewModalHandle(c *Comp) *ModalHandle { return &ModalHandle{Handle{c}} }
func (h *ModalHandle) Title() string      { return h.c.Str("title") }
func (h *ModalHandle) SetTitle(v string)  { h.c.Set("title", v) }
func (h *ModalHandle) IsOpen() bool       { return h.c.Bool("open") }
func (h *ModalHandle) Open()              { h.c.Set("open", true) }
func (h *ModalHandle) Close()             { h.c.Set("open", false) }

// Hide closes the modal.
func (h *ModalHandle) Hide() error {
	h.Close()
	return nil
}
