"""The wake-word matcher and the fast-path grammar."""
import pytest

from jarvis import fastpath
from jarvis.wake import match, skeleton


@pytest.mark.parametrize("text, rest", [
    ("Adenine, go back.", "go back."),
    ("adenine next", "next"),
    ("Adonine, show me the pipeline", "show me the pipeline"),
    ("Add an AIN, next.", "next."),
    ("add an ain go back", "go back"),
    ("A denine, focus the tools", "focus the tools"),
    ("A-denine: open the session store", "open the session store"),
    ("Adenin. What does this do?", "What does this do?"),
    ("Hey Adenine, theater.", "theater."),
    ("Ok adenine zoom out", "zoom out"),
    ("ADENINE!", ""),
    ("Adenine. Zoom into the pipeline and show me the schema that's passed.",
     "Zoom into the pipeline and show me the schema that's passed."),
])
def test_wake_variants(text, rest):
    m = match(text, "adenine")
    assert m.wake, text
    assert m.rest == rest


@pytest.mark.parametrize("text", [
    "Go back.", "Adding nine nodes to the board", "and then show it", "a dinner", "Aden, next", "anyone there",
    "Open the session store", "the adenine molecule",  # not at the start
    "", "   ",
])
def test_wake_non_matches(text):
    m = match(text, "adenine")
    assert not m.wake, text
    assert m.rest == text.strip()


def test_wake_word_is_configurable():
    assert match("Jarvis, next", "jarvis") == match("Jarvis, next", "Jarvis")
    assert match("Jarvis, next", "jarvis").rest == "next"
    assert match("Jervis next", "jarvis").wake
    assert not match("Adenine, next", "jarvis").wake
    assert match("Hey Karyo, go back", "hey karyo").rest == "go back"  # a two-word wake phrase
    assert match("mix next", "mux").wake and not match("mixer next", "mux").wake


def test_skeleton():
    assert skeleton("addanain") == skeleton("adenine") == "adn"


@pytest.mark.parametrize("text, name, args", [
    ("back", "back", {}), ("Go back.", "back", {}), ("next", "step", {"to": "next"}),
    ("Previous.", "step", {"to": "prev"}), ("prev", "step", {"to": "prev"}), ("Zoom out", "zoom", {"to": "out"}),
    ("clear", "clear", {}), ("Theater", "theater", {"on": True}), ("full screen, please", "theater", {"on": True}),
    ("Exit theater.", "theater", {"on": False}), ("Fan out!", "fan", {"on": True}), ("collapse", "fan", {"on": False}),
    ("Scroll down.", "scroll", {"to": "down"}), ("page up", "scroll", {"to": "up"}), ("Scroll to the top.", "scroll", {"to": "top"}),
    ("Pin the inspector.", "pin_inspector", {"on": True}), ("unpin", "pin_inspector", {"on": False}),
    ("Unpin the inspector, please", "pin_inspector", {"on": False}), ("dock the inspector", "pin_inspector", {"on": True}),
    ("Pin the inspector to the left.", "pin_inspector", {"on": True, "side": "left"}),
    ("Lock the inspector", "pin_inspector", {"lock": True}), ("unlock the inspector", "pin_inspector", {"lock": False}),
    ("Undo.", "splice_undo", {}), ("undo that", "splice_undo", {}), ("Redo", "splice_redo", {}),
    ("Leave the splice.", "splice_leave", {}), ("exit the splice please", "splice_leave", {}), ("Save the splice", "splice_save", {}),
    ("Stack my splices.", "splice_stack", {}), ("compare the splices", "splice_stack", {}), ("Back to the stack.", "splice_stack_return", {}),
    ("leave the stack please", "splice_stack_leave", {}), ("Close the stack", "splice_stack_leave", {}),
    ("zoom in", "zoom", {"to": "in"}), ("Zoom out.", "zoom", {"to": "out"}), ("reset zoom", "zoom", {"to": "fit"}),
    ("zoom to fit please", "zoom", {"to": "fit"}), ("pan left", "pan", {"direction": "left"}), ("Pan down.", "pan", {"direction": "down"}),
    ("clear", "clear", {}),
    ("Swap the order.", "splice_stack_swap", {}), ("try the other order", "splice_stack_swap", {}),
    ("Splice this.", "splice_open", {"new": True}), ("splice this view please", "splice_open", {"new": True}),
    ("Open this view in a new splice", "splice_open", {"new": True}),
])
def test_fast_path(text, name, args):
    hit = fastpath.lookup(text)
    assert hit and hit[0] == name and hit[1] == args


@pytest.mark.parametrize("text", ["go back to the pipeline", "next to the store", "what's next", "clear the tags please now ok", "zoom into the pipeline", "zoom to the session store", "zoom in on the checkout", "scroll to pipeline_run", "pin the inspector on the session store",
                                  "open this view in a new splice called caching", "undo the cache", "save the splice as caching",
                                  "compare caching and queueing", "combine them", "combine caching and queueing", "open the queueing one", "stack caching and queueing",
                                  "they're the same cache", "replace the session store with queueing"])
def test_fast_path_leaves_the_rest_to_claude(text):
    assert fastpath.lookup(text) is None
