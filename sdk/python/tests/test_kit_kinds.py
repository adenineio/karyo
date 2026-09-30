"""A node kind may be a kit's (docs/KITS.md): any other lowercase word; a near miss of a built-in kind is still a typo."""
from karyo import directives


def test_a_kit_kind_is_accepted():
    p = directives.read("# karyo:node id=pkg.jobs kind=worker label=Jobs\nclass Jobs: pass\n", "m.py")
    assert not p.problems, [str(x) for x in p.problems]
    assert [d.attrs.get("kind") for d in p.directives] == ["worker"]


def test_a_typo_of_a_builtin_kind_is_still_reported():
    p = directives.read("# karyo:node id=pkg.x kind=servce\ndef f(): pass\n", "m.py")
    assert any("did you mean 'service'" in x.message for x in p.problems)


def test_an_edge_kind_stays_strict():
    p = directives.read("# karyo:edge from=a to=b kind=worker\n", "m.py")
    assert any("not a edge kind" in x.message for x in p.problems)
