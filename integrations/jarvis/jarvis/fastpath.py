"""Commands common and unambiguous enough to skip Claude: said alone, they map to one action."""
from __future__ import annotations

from typing import Any

from jarvis.wake import norm

_PHRASES: dict[str, tuple[str, dict[str, Any], str]] = {}


def _add(phrases: list[str], name: str, args: dict[str, Any], activity: str) -> None:
    for p in phrases:
        _PHRASES[" ".join(norm(w) for w in p.split())] = (name, args, activity)


_add(["back", "go back"], "back", {}, "went back")
# group navigation on a structure board (docs/ENGINE.md "Group navigation")
_add(["up a level", "go up a level", "up one level", "go up one level", "level up", "go up", "zoom out a level", "out a level"],
     "drill", {"group": "out"}, "went up a level")
_add(["all groups", "show all groups", "show the groups", "show me the groups", "back to all groups", "back to the overview",
      "the overview", "go to the top", "top level", "groups view", "group view"], "groups", {"on": True}, "showed the groups")
_add(["all cards", "show all cards", "show every card", "show all the cards", "every card", "cards view"], "groups", {"on": False},
     "showed every card")
_add(["next", "next step"], "step", {"to": "next"}, "next step")
_add(["previous", "prev", "previous step", "go back a step"], "step", {"to": "prev"}, "previous step")
_add(["clear"], "clear", {}, "cleared the view")
# zoom and pan (docs/ENGINE.md "Zoom and pan"); "zoom out" at fit still goes back to the overview (the page decides)
_add(["zoom in", "zoom in a bit", "closer", "zoom closer"], "zoom", {"to": "in"}, "zoomed in")
_add(["zoom out", "zoom out a bit", "further out"], "zoom", {"to": "out"}, "zoomed out")
_add(["reset zoom", "reset the zoom", "zoom to fit", "fit", "fit to screen", "fit the screen", "zoom all the way out", "show everything",
      "show the whole thing"], "zoom", {"to": "fit"}, "back to fit")
for _d in ("left", "right", "up", "down"):
    _add([f"pan {_d}", f"move {_d}", f"scroll {_d} a bit" if _d in ("left", "right") else f"pan the view {_d}", f"look {_d}"],
         "pan", {"direction": _d}, f"panned {_d}")
_add(["theater", "theatre", "full screen", "fullscreen", "theater mode", "theatre mode"], "theater", {"on": True}, "entered the theater")
_add(["exit theater", "exit theatre", "leave theater", "leave theatre", "exit full screen", "exit fullscreen"],
     "theater", {"on": False}, "left the theater")
_add(["fan out", "fan"], "fan", {"on": True}, "fanned out")
_add(["collapse", "fold", "fold up"], "fan", {"on": False}, "collapsed")
_add(["scroll down", "scroll", "page down"], "scroll", {"to": "down"}, "scrolled down")
_add(["scroll up", "page up"], "scroll", {"to": "up"}, "scrolled up")
_add(["scroll to the top", "back to the top", "scroll up to the top"], "scroll", {"to": "top"}, "scrolled to the top")
_add(["scroll to the bottom", "scroll to the end"], "scroll", {"to": "bottom"}, "scrolled to the bottom")

_add(["pin the inspector", "pin inspector", "pin the inspector to the side", "dock the inspector", "pin the panel",
      "pin the details"], "pin_inspector", {"on": True}, "pinned the inspector")
_add(["unpin the inspector", "unpin inspector", "unpin", "undock the inspector", "unpin the panel", "unpin the details"],
     "pin_inspector", {"on": False}, "unpinned the inspector")
_add(["pin the inspector left", "pin the inspector to the left", "move the inspector to the left", "inspector on the left"],
     "pin_inspector", {"on": True, "side": "left"}, "pinned the inspector on the left")
_add(["pin the inspector right", "pin the inspector to the right", "move the inspector to the right", "inspector on the right"],
     "pin_inspector", {"on": True, "side": "right"}, "pinned the inspector on the right")
_add(["lock the inspector", "lock inspector", "lock it"], "pin_inspector", {"lock": True}, "locked the inspector")
_add(["unlock the inspector", "unlock inspector", "unlock it"], "pin_inspector", {"lock": False}, "unlocked the inspector")

# splices: proposals only (docs/JARVIS.md "Splices")
_add(["undo", "undo that", "undo it", "undo the last change", "take that back"], "splice_undo", {}, "undid the last proposal")
_add(["redo", "redo that", "redo it"], "splice_redo", {}, "redid the proposal")
_add(["leave the splice", "exit the splice", "close the splice", "leave splice", "exit splice", "back to the real view"],
     "splice_leave", {}, "left the splice")
_add(["save the splice", "save splice", "save this splice"], "splice_save", {}, "saved the splice")
# "splice this": the view on screen in a new splice (a name is asked for on save); named ones go to Claude
_add(["splice this", "splice this view", "splice it", "splice here", "open this view in a new splice", "open this in a new splice",
      "start a splice here", "new splice here"], "splice_open", {"new": True}, "opened a new splice of this view")
# a stack of splices: only the phrasings that name no splice (the rest go to Claude)
_add(["stack my splices", "stack the splices", "stack splices", "stack all the splices", "stack all splices", "compare my splices",
      "compare the splices", "compare all the splices", "show the splice stack"], "splice_stack", {}, "stacked the splices")
_add(["back to the stack", "go back to the stack", "return to the stack", "back to the splice stack"], "splice_stack_return", {},
     "back to the stack of splices")
_add(["leave the stack", "close the stack", "exit the stack", "leave the splice stack", "close the splice stack"],
     "splice_stack_leave", {}, "left the stack of splices")
_add(["swap the order", "switch the order", "reverse the order", "flip the order", "swap the order of the splices",
      "the other order", "try the other order"], "splice_stack_swap", {}, "swapped the combination's order")

_POLITE = {"please", "now"}


def lookup(text: str) -> tuple[str, dict[str, Any], str] | None:
    """(action name, args, activity line) when `text` is a fast-path command, else None."""
    words = [norm(w) for w in text.split()]
    words = [w for w in words if w]
    while words and words[0] in _POLITE:
        words.pop(0)
    while words and words[-1] in _POLITE:
        words.pop()
    hit = _PHRASES.get(" ".join(words))
    return (hit[0], dict(hit[1]), hit[2]) if hit else None
