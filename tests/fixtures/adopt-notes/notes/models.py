"""The note itself."""
from dataclasses import dataclass, field


@dataclass
class Note:
    """One note: a title, a body and some tags."""
    slug: str
    title: str
    body: str = ""
    tags: list[str] = field(default_factory=list)
    archived: bool = False


def slugify(title: str) -> str:
    """A URL-safe id from a title."""
    return "-".join(_words(title))


def _words(text: str) -> list[str]:
    return [w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split() if w]
