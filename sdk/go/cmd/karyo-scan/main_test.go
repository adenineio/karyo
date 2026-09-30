package main

import (
	"reflect"
	"testing"
)

func TestParseKVListKeysAddUpOtherRepeatsAreReported(t *testing.T) {
	kv, dup := parseKV(`id=a calls=b calls=c,d label="A b" label=x`)
	if kv["calls"] != "b,c,d" || kv["id"] != "a" {
		t.Fatalf("kv = %v", kv)
	}
	if !reflect.DeepEqual(dup, []string{"label"}) {
		t.Fatalf("dup = %v", dup)
	}
}

func TestDirectiveTextAcceptsBothSpellings(t *testing.T) {
	for _, c := range []string{"//karyo:node id=a", "// karyo:node id=a"} {
		if s, ok := directiveText(c); !ok || s != "node id=a" {
			t.Fatalf("%q -> %q %v", c, s, ok)
		}
	}
	if _, ok := directiveText("// see karyo: docs"); ok {
		t.Fatal("prose is not a directive")
	}
	if !continueRE.MatchString("//   calls=x") || continueRE.MatchString("// calls=x") {
		t.Fatal("continuation lines are `//` and three or more spaces")
	}
}

func TestIDs(t *testing.T) {
	for id, ok := range map[string]bool{"payments.charge": true, "acme.example/payments": true, "a b": false, "a->b": false, "": false} {
		if idRE.MatchString(id) != ok {
			t.Fatalf("%q valid=%v", id, !ok)
		}
	}
}
