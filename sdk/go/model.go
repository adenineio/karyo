// Package model describes how Go code fits together, for Karyo.
//
// Three sources of truth, one output file (a Karyo model fragment):
//
//	declared   //karyo:node directives (read by cmd/karyo-scan) or Declare() at runtime
//	extracted  cmd/karyo-scan: directives parsed with go/parser, imports from `go list -json`
//	observed   spans recorded with Span() inside a Flow(), joined across processes by a trace id
//	           passed in KARYO_TRACE / KARYO_PARENT (Env) or karyo-trace / karyo-parent headers
//
// Standard library only. See docs/MODEL.md in the Karyo repo.
package model

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const Version = "0.1.0"

// Node is one thing in the system: a service, function, store, queue, external dependency, actor or module.
type Node struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label,omitempty"`
	Summary string `json:"summary,omitempty"`
	Group   string `json:"group,omitempty"`
	// Category is one declared word (tool, store, stage, …) views can color or filter by; Tags are
	// free-form declared labels. Both come from `category=` / `tags=` in a //karyo:node directive.
	Category string   `json:"category,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Module   string   `json:"module,omitempty"`
	Lang     string   `json:"lang,omitempty"`
	Ref      *Ref     `json:"ref,omitempty"`
	Code     *Code    `json:"code,omitempty"`
	Sources  []string `json:"sources"`
}

// Code is a declaration's source as the model carries it: doc comment included, lines Start..End
// of File, at most CodeMaxLines lines (Truncated when the declaration is longer; End is then the
// last line kept).
type Code struct {
	File      string `json:"file"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Lang      string `json:"lang"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

// CodeMaxLines caps the source carried per node.
const CodeMaxLines = 80

// Excerpt builds a Code from a file's lines (all of them, 0-based slice) for lines start..end (1-based, inclusive).
func Excerpt(file string, lines []string, start, end int) *Code {
	if start < 1 {
		start = 1
	}
	if end > len(lines) {
		end = len(lines)
	}
	if end < start {
		return nil
	}
	c := &Code{File: file, Start: start, End: end, Lang: "go"}
	if end-start+1 > CodeMaxLines {
		c.End, c.Truncated = start+CodeMaxLines-1, true
	}
	c.Text = strings.Join(lines[start-1:c.End], "\n")
	return c
}

// Ref points at code.
type Ref struct {
	File   string `json:"file"`
	Line   int    `json:"line,omitempty"`
	Symbol string `json:"symbol,omitempty"`
}

// Edge is a relationship between two nodes.
type Edge struct {
	From    string   `json:"from"`
	To      string   `json:"to"`
	Kind    string   `json:"kind"`
	Label   string   `json:"label,omitempty"`
	Sources []string `json:"sources"`
}

// SpanRecord is one recorded call of a node.
type SpanRecord struct {
	ID     string         `json:"id"`
	Parent *string        `json:"parent"`
	Node   string         `json:"node"`
	Label  string         `json:"label,omitempty"`
	Start  int64          `json:"start"`
	End    int64          `json:"end"`
	Status string         `json:"status"`
	Lang   string         `json:"lang"`
	Flow   string         `json:"flow,omitempty"`
	Attrs  map[string]any `json:"attrs,omitempty"`
}

type flowRec struct {
	ID    string        `json:"id"`
	Title string        `json:"title,omitempty"`
	Trace string        `json:"trace"`
	Entry string        `json:"entry,omitempty"`
	Spans []*SpanRecord `json:"spans"`
}

var (
	mu    sync.Mutex
	nodes = map[string]*Node{}
	edges = map[[3]string]*Edge{}
	flows = map[string]*flowRec{}
	order []string
)

type ctxKey int

const (
	keyTrace ctxKey = iota
	keySpan
	keyRemoteParent
)

func newID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Declare registers a node at runtime (directives read by karyo-scan are the static equivalent).
// calls lists the ids this node is declared to call.
func Declare(n Node, calls ...string) {
	if n.Lang == "" {
		n.Lang = "go"
	}
	if n.Kind == "" { // the scan's default for a //karyo:node, so both describe the node the same way
		n.Kind = "function"
	}
	if n.Ref == nil {
		if _, file, line, ok := runtime.Caller(1); ok {
			if rel, err := filepath.Rel(root(), file); err == nil {
				file = rel
			}
			n.Ref = &Ref{File: filepath.ToSlash(file), Line: line}
		}
	}
	n.Sources = []string{"declared"}
	mu.Lock()
	defer mu.Unlock()
	if _, ok := nodes[n.ID]; !ok {
		nodes[n.ID] = &n
	}
	for _, c := range calls {
		k := [3]string{n.ID, c, "calls"}
		if _, ok := edges[k]; !ok {
			edges[k] = &Edge{From: n.ID, To: c, Kind: "calls", Sources: []string{"declared"}}
		}
	}
}

// Flow starts a traced flow, or continues the trace in KARYO_TRACE / KARYO_PARENT when this
// process was started by another traced process.
func Flow(ctx context.Context, id, title string) context.Context {
	trace := os.Getenv("KARYO_TRACE")
	if trace == "" {
		trace = newID(8)
	}
	mu.Lock()
	if _, ok := flows[trace]; !ok {
		flows[trace] = &flowRec{ID: id, Title: title, Trace: trace}
		order = append(order, trace)
	}
	mu.Unlock()
	ctx = context.WithValue(ctx, keyTrace, trace)
	if p := os.Getenv("KARYO_PARENT"); p != "" {
		ctx = context.WithValue(ctx, keyRemoteParent, p)
	}
	return ctx
}

// FlowFromHeaders continues a trace received over HTTP (karyo-trace / karyo-parent headers).
func FlowFromHeaders(ctx context.Context, id, title, trace, parent string) context.Context {
	if trace == "" {
		return Flow(ctx, id, title)
	}
	mu.Lock()
	if _, ok := flows[trace]; !ok {
		flows[trace] = &flowRec{ID: id, Title: title, Trace: trace}
		order = append(order, trace)
	}
	mu.Unlock()
	ctx = context.WithValue(ctx, keyTrace, trace)
	if parent != "" {
		ctx = context.WithValue(ctx, keyRemoteParent, parent)
	}
	return ctx
}

// Span records one call of node. Call the returned func when the call ends, with its error (or nil).
// Outside a Flow it does nothing.
func Span(ctx context.Context, node, label string) (context.Context, func(error)) {
	trace, _ := ctx.Value(keyTrace).(string)
	if trace == "" {
		return ctx, func(error) {}
	}
	var parent *string
	if p, ok := ctx.Value(keySpan).(*SpanRecord); ok {
		parent = &p.ID
	} else if rp, ok := ctx.Value(keyRemoteParent).(string); ok {
		parent = &rp
	}
	s := &SpanRecord{ID: newID(6), Parent: parent, Node: node, Label: label, Start: time.Now().UnixNano(), Status: "ok", Lang: "go"}
	mu.Lock()
	f := flows[trace]
	if parent == nil && len(f.Spans) == 0 {
		s.Flow = f.ID
	}
	f.Spans = append(f.Spans, s)
	mu.Unlock()
	return context.WithValue(ctx, keySpan, s), func(err error) {
		mu.Lock()
		defer mu.Unlock()
		s.End = time.Now().UnixNano()
		if err != nil {
			s.Status = "error"
			s.Attrs = map[string]any{"error": err.Error()}
		}
	}
}

// Env returns KARYO_TRACE / KARYO_PARENT for a child process, so its spans join this trace
// under the current span. Append to cmd.Env.
func Env(ctx context.Context) []string {
	trace, _ := ctx.Value(keyTrace).(string)
	if trace == "" {
		return nil
	}
	env := []string{"KARYO_TRACE=" + trace}
	if s, ok := ctx.Value(keySpan).(*SpanRecord); ok {
		env = append(env, "KARYO_PARENT="+s.ID)
	}
	return env
}

// Headers returns the same context as HTTP headers.
func Headers(ctx context.Context) map[string]string {
	h := map[string]string{}
	if t, _ := ctx.Value(keyTrace).(string); t != "" {
		h["karyo-trace"] = t
	}
	if s, ok := ctx.Value(keySpan).(*SpanRecord); ok {
		h["karyo-parent"] = s.ID
	}
	return h
}

func root() string {
	if r := os.Getenv("KARYO_ROOT"); r != "" {
		return r
	}
	wd, _ := os.Getwd()
	return wd
}

// Fragment returns what this process recorded as a Karyo model fragment.
func Fragment() map[string]any {
	mu.Lock()
	defer mu.Unlock()
	ns := make([]*Node, 0, len(nodes))
	for _, n := range nodes {
		ns = append(ns, n)
	}
	es := make([]*Edge, 0, len(edges))
	for _, e := range edges {
		es = append(es, e)
	}
	fs := make([]*flowRec, 0, len(order))
	now := time.Now().UnixNano()
	for _, t := range order {
		f := flows[t]
		for _, s := range f.Spans {
			if s.End == 0 {
				s.End = now
			}
		}
		fs = append(fs, f)
	}
	return map[string]any{
		"karyo":     1,
		"producers": []map[string]string{{"name": "karyo-go", "lang": "go", "version": Version, "at": time.Now().UTC().Format(time.RFC3339)}},
		"nodes":     ns,
		"edges":     es,
		"flows":     fs,
	}
}

// Write writes the fragment to $KARYO_OUT/go-<pid>.karyo.json (KARYO_OUT defaults to .karyo).
func Write() (string, error) {
	dir := os.Getenv("KARYO_OUT")
	if dir == "" {
		dir = ".karyo"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("go-%d.karyo.json", os.Getpid()))
	b, err := json.MarshalIndent(Fragment(), "", " ")
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, b, 0o644)
}
