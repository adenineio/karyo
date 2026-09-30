"""Where notes live (in memory)."""
from .models import Note


class NoteStore:
    """Notes by slug, with a word index for search."""

    def __init__(self) -> None:
        self._notes: dict[str, Note] = {}
        self._index: dict[str, set[str]] = {}

    def put(self, note: Note) -> None:
        """Save a note and index its words."""
        self._notes[note.slug] = note
        for word in _tokens(note):
            self._index.setdefault(word, set()).add(note.slug)

    def get(self, slug: str) -> Note | None:
        """The note with this slug, if any."""
        return self._notes.get(slug)

    def search(self, word: str) -> list[Note]:
        """Notes whose title, body or tags hold the word."""
        return [self._notes[s] for s in sorted(self._index.get(word.lower(), ()))]

    def delete(self, slug: str) -> bool:
        """Forget a note."""
        return self._notes.pop(slug, None) is not None


def _tokens(note: Note) -> set[str]:
    return {w.lower() for w in f"{note.title} {note.body} {' '.join(note.tags)}".split()}
