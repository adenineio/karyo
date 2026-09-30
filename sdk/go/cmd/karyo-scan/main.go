// Command karyo-scan statically describes Go packages as a Karyo model fragment:
// //karyo:node, //karyo:external and //karyo:edge directives (parsed with go/parser), and the
// import graph between the scanned packages (from `go list -json`). Nothing is built or run.
//
//	go run karyo.dev/model/cmd/karyo-scan [-root dir] [packages...] > go.static.karyo.json
//
// Directive syntax (in a doc comment or anywhere in a file), values may be quoted:
//
//	//karyo:node id=payments.charge kind=service label="Charge card" category=api tags=money calls=payments.fraud,payments.ledger
//	//karyo:external id=stripe.api label="Stripe" category=outside
//	//karyo:edge from=payments.ledger to=payments.db kind=writes
//
// A comment line of the form `//   key=value` (three or more spaces) continues the directive above it,
// and a list key (tags, calls, reads, writes, publishes) may repeat: its values add up. A malformed
// directive (an unknown verb, key, node or edge kind, a bad or missing id, a key given twice) is a
// `directive-invalid` warning (printed, and in the fragment's checks) and is ignored, so a typo never
// passes silently and never becomes a node or an edge. Same grammar as the Python SDK's `# karyo:`.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	model "karyo.dev/model"
)

type pkg struct {
	ImportPath string
	Dir        string
	GoFiles    []string
	Imports    []string
}

func main() {
	rootDir := flag.String("root", ".", "file paths in refs are relative to this directory")
	flag.Parse()
	pats := flag.Args()
	if len(pats) == 0 {
		pats = []string{"./..."}
	}
	root, _ := filepath.Abs(*rootDir)

	out, err := exec.Command("go", append([]string{"list", "-json"}, pats...)...).Output()
	if err != nil {
		fail("go list: %v", err)
	}
	var pkgs []pkg
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var p pkg
		if err := dec.Decode(&p); err == io.EOF {
			break
		} else if err != nil {
			fail("decode go list: %v", err)
		}
		pkgs = append(pkgs, p)
	}
	inSet := map[string]bool{}
	for _, p := range pkgs {
		inSet[p.ImportPath] = true
	}

	nodes := map[string]*model.Node{}
	edges := map[[3]string]*model.Edge{}
	var checks []map[string]string
	invalid := func(file string, line int, msg string) {
		subject := fmt.Sprintf("%s:%d", file, line)
		fmt.Fprintf(os.Stderr, "karyo-scan: warning: %s: %s\n", subject, msg)
		checks = append(checks, map[string]string{"level": "warn", "code": "directive-invalid", "subject": subject, "message": subject + ": " + msg})
	}
	addEdge := func(a, b, kind, label, source string) {
		k := [3]string{a, b, kind}
		if e, ok := edges[k]; ok {
			if e.Label == "" {
				e.Label = label
			}
			if !contains(e.Sources, source) { // a declared import and an extracted one: both sources
				e.Sources = append(e.Sources, source)
			}
			return
		}
		edges[k] = &model.Edge{From: a, To: b, Kind: kind, Label: label, Sources: []string{source}}
	}
	declaredAt := map[string]string{} // node id -> file:line of its node directive
	rel := func(path string) string {
		if r, err := filepath.Rel(root, path); err == nil {
			return filepath.ToSlash(r)
		}
		return filepath.ToSlash(path)
	}

	for _, p := range pkgs {
		group := p.ImportPath[strings.LastIndex(p.ImportPath, "/")+1:]
		// a declaration that took the package's name keeps it (reported where it's declared; the merge refuses it)
		if cur, ok := nodes[p.ImportPath]; !ok || cur.Kind == "module" {
			nodes[p.ImportPath] = &model.Node{ID: p.ImportPath, Kind: "module", Label: p.ImportPath, Group: group, Module: p.ImportPath, Lang: "go", Sources: []string{"extracted"}}
		}
		for _, imp := range p.Imports {
			if inSet[imp] {
				addEdge(p.ImportPath, imp, "imports", "", "extracted")
			}
		}
		fset := token.NewFileSet()
		for _, f := range p.GoFiles {
			path := filepath.Join(p.Dir, f)
			src, err := os.ReadFile(path)
			if err != nil {
				fail("read %s: %v", path, err)
			}
			lines := strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n")
			file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
			if err != nil {
				fail("parse %s: %v", path, err)
			}
			if nodes[p.ImportPath].Kind == "module" && nodes[p.ImportPath].Ref == nil {
				nodes[p.ImportPath].Ref = &model.Ref{File: rel(path), Line: 1}
			}
			// which declaration each comment belongs to, for refs
			owner := map[*ast.CommentGroup]ast.Decl{}
			for _, d := range file.Decls {
				switch x := d.(type) {
				case *ast.FuncDecl:
					if x.Doc != nil {
						owner[x.Doc] = x
					}
				case *ast.GenDecl:
					if x.Doc != nil {
						owner[x.Doc] = x
					}
				}
			}
			for _, cg := range file.Comments {
				for ci := 0; ci < len(cg.List); ci++ {
					c := cg.List[ci]
					text, ok := directiveText(c.Text)
					if !ok {
						continue
					}
					// `//   key=value` lines right below continue it
					for ci+1 < len(cg.List) {
						more := cg.List[ci+1].Text
						if _, isDir := directiveText(more); isDir || !continueRE.MatchString(more) {
							break
						}
						text += " " + strings.TrimSpace(strings.TrimPrefix(more, "//"))
						ci++
					}
					verb, rest, _ := strings.Cut(text, " ")
					kv, dup := parseKV(rest)
					line := fset.Position(c.Slash).Line
					var problems []string
					allowed, known := directiveKeys[verb]
					if !known {
						problems = append(problems, fmt.Sprintf("unknown directive karyo:%s (one of node, external, edge)", verb))
					}
					for k := range kv {
						if known && !contains(allowed, k) {
							problems = append(problems, fmt.Sprintf("karyo:%s has no key %q (keys: %s)", verb, k, strings.Join(allowed, ", ")))
						}
					}
					for _, k := range dup {
						problems = append(problems, fmt.Sprintf("%s given twice", k))
					}
					switch verb {
					case "node", "external":
						if k := kv["kind"]; k != "" && !contains(nodeKinds, k) && !isKitKind(k) {
							problems = append(problems, fmt.Sprintf("kind: %q is not a node kind (one of %s)", k, strings.Join(nodeKinds, ", ")))
						}
						if kv["id"] == "" {
							problems = append(problems, fmt.Sprintf("karyo:%s needs id=", verb))
						}
					case "edge":
						if k := kv["kind"]; k != "" && !contains(edgeKinds, k) {
							problems = append(problems, fmt.Sprintf("kind: %q is not an edge kind (one of %s)", k, strings.Join(edgeKinds, ", ")))
						}
						if kv["from"] == "" || kv["to"] == "" {
							problems = append(problems, "karyo:edge needs from= and to=")
						}
					}
					for _, k := range []string{"id", "from", "to"} {
						if v := kv[k]; v != "" && !idRE.MatchString(v) {
							problems = append(problems, fmt.Sprintf("%s: %q is not a valid id (letters, digits and _ . : / -)", k, v))
						}
					}
					for _, k := range []string{"calls", "reads", "writes", "publishes"} {
						for _, t := range splitList(kv[k]) {
							if !idRE.MatchString(t) {
								problems = append(problems, fmt.Sprintf("%s: %q is not a valid id", k, t))
							}
						}
					}
					if len(problems) > 0 { // a malformed directive is reported and ignored, never half-applied
						for _, pr := range problems {
							invalid(rel(path), line, pr)
						}
						continue
					}
					switch verb {
					case "node", "external":
						id := kv["id"]
						if inSet[id] {
							invalid(rel(path), line, fmt.Sprintf("node id %s is also the name of package %s; node ids and module names share one namespace: rename the node", id, id))
						}
						kind := kv["kind"]
						if kind == "" {
							kind = map[string]string{"node": "function", "external": "external"}[verb]
						}
						n := &model.Node{ID: id, Kind: kind, Label: kv["label"], Summary: kv["summary"], Group: kv["group"],
							Category: kv["category"], Tags: splitList(kv["tags"]), Sources: []string{"declared"}}
						if verb == "node" {
							if at, ok := declaredAt[id]; ok {
								invalid(rel(path), line, fmt.Sprintf("node %s is declared twice (also at %s)", id, at))
							}
							declaredAt[id] = fmt.Sprintf("%s:%d", rel(path), line)
							n.Module, n.Lang = p.ImportPath, "go"
							if n.Group == "" {
								n.Group = strings.Split(id, ".")[0] // the id's first segment (a Python node's default is its top-level package)
							}
							ref := &model.Ref{File: rel(path), Line: line}
							if d, ok := owner[cg]; ok {
								ref.Line = fset.Position(d.Pos()).Line
								// the declaration's source, its doc comment included
								n.Code = model.Excerpt(rel(path), lines, fset.Position(cg.Pos()).Line, fset.Position(d.End()).Line)
								if fd, ok := d.(*ast.FuncDecl); ok {
									ref.Symbol = fd.Name.Name
									if fd.Recv != nil && len(fd.Recv.List) > 0 {
										ref.Symbol = recvName(fd.Recv.List[0].Type) + "." + fd.Name.Name
									}
									if n.Label == "" {
										n.Label = fd.Name.Name
									}
									if n.Summary == "" && fd.Doc != nil {
										n.Summary = firstDocLine(fd.Doc)
									}
								}
							}
							n.Ref = ref
						} else if n.Group == "" {
							n.Group = strings.Split(id, ".")[0]
						}
						if n.Label == "" {
							n.Label = id
						}
						if cur, exists := nodes[id]; !exists || verb == "node" || cur.Kind == "module" {
							nodes[id] = n
						}
						for _, k := range []string{"calls", "reads", "writes", "publishes"} {
							for _, t := range splitList(kv[k]) {
								addEdge(id, t, k, "", "declared")
							}
						}
					case "edge":
						kind := kv["kind"]
						if kind == "" {
							kind = "calls"
						}
						addEdge(kv["from"], kv["to"], kind, kv["label"], "declared")
					}
				}
			}
		}
	}

	ns := make([]*model.Node, 0, len(nodes))
	for _, n := range nodes {
		ns = append(ns, n)
	}
	sort.Slice(ns, func(i, j int) bool { return ns[i].ID < ns[j].ID })
	es := make([]*model.Edge, 0, len(edges))
	for _, e := range edges {
		es = append(es, e)
	}
	sort.Slice(es, func(i, j int) bool { return es[i].From+es[i].To < es[j].From+es[j].To })
	frag := map[string]any{
		"karyo":     1,
		"producers": []map[string]string{{"name": "karyo-go scan", "lang": "go", "version": model.Version, "at": time.Now().UTC().Format(time.RFC3339)}},
		"nodes":     ns, "edges": es, "flows": []any{},
	}
	if len(checks) > 0 {
		frag["checks"] = checks
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(frag); err != nil {
		fail("%v", err)
	}
	fmt.Fprintf(os.Stderr, "karyo-scan: %d nodes, %d edges\n", len(ns), len(es))
}

var directiveKeys = map[string][]string{
	"node":     {"id", "kind", "label", "summary", "group", "category", "tags", "calls", "reads", "writes", "publishes"},
	"external": {"id", "kind", "label", "summary", "group", "category", "tags"},
	"edge":     {"from", "to", "kind", "label"},
}

var nodeKinds = []string{"service", "function", "type", "store", "queue", "external", "actor", "module"}
var edgeKinds = []string{"calls", "reads", "writes", "publishes", "subscribes", "imports"}

// idRE is the model's id (spec/karyo-model.schema.json), the same as the Python SDK's.
var idRE = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$`)
var continueRE = regexp.MustCompile(`^//\s{3,}\S`)

// list keys may repeat (their values add up); any other key given twice is a mistake
var listKeys = []string{"tags", "calls", "reads", "writes", "publishes"}

// directiveText returns what follows `//karyo:` (or `// karyo:`, as Python accepts `# karyo:`).
func directiveText(comment string) (string, bool) {
	t := strings.TrimPrefix(comment, "//")
	t = strings.TrimPrefix(t, " ")
	if !strings.HasPrefix(t, "karyo:") {
		return "", false
	}
	return strings.TrimPrefix(t, "karyo:"), true
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// parseKV parses `a=b c="d e" f=g,h`: list keys given twice add up, other keys given twice are returned in dup.
func parseKV(s string) (map[string]string, []string) {
	m := map[string]string{}
	var dup []string
	for s = strings.TrimSpace(s); s != ""; s = strings.TrimSpace(s) {
		k, rest, ok := strings.Cut(s, "=")
		if !ok {
			break
		}
		var v string
		if strings.HasPrefix(rest, `"`) {
			end := strings.Index(rest[1:], `"`)
			if end < 0 {
				v, s = rest[1:], ""
			} else {
				v, s = rest[1:end+1], rest[end+2:]
			}
		} else {
			v, s, _ = strings.Cut(rest, " ")
		}
		k = strings.TrimSpace(k)
		if old, ok := m[k]; ok {
			if contains(listKeys, k) {
				m[k] = old + "," + v
				continue
			}
			dup = append(dup, k)
		}
		m[k] = v
	}
	return m, dup
}

func splitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func recvName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return recvName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return recvName(t.X)
	}
	return "?"
}

func firstDocLine(cg *ast.CommentGroup) string {
	for _, l := range strings.Split(cg.Text(), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "karyo:") {
			return l
		}
	}
	return ""
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "karyo-scan: "+f+"\n", a...)
	os.Exit(1)
}

// isKitKind: a node kind a kit adds (docs/KITS.md) is any other lowercase word, unless it reads as a typo of a
// built-in kind (one or two edits from one: "servce", "stor").
func isKitKind(k string) bool {
	if !regexp.MustCompile(`^[a-z][a-z0-9-]*$`).MatchString(k) {
		return false
	}
	for _, b := range nodeKinds {
		if d := editDistance(k, b); d <= 1 || (d == 2 && len(b) >= 6) {
			return false
		}
	}
	return true
}

func editDistance(a, b string) int {
	d := make([]int, len(b)+1)
	for j := range d {
		d[j] = j
	}
	for i := 1; i <= len(a); i++ {
		prev := d[0]
		d[0] = i
		for j := 1; j <= len(b); j++ {
			t := d[j]
			c := prev
			if a[i-1] != b[j-1] {
				c++
			}
			d[j] = min(d[j]+1, d[j-1]+1, c)
			prev = t
		}
	}
	return d[len(b)]
}
