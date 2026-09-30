"""What the app does with notes."""
from .models import Note, slugify
from .store import NoteStore


class NotesService:
    """Create, find and archive notes."""

    def __init__(self, store: NoteStore | None = None) -> None:
        self.store = store or NoteStore()

    def create(self, title: str, body: str = "", tags: list[str] | None = None) -> Note:
        """Make a note and save it."""
        note = Note(slugify(title), title, body, list(tags or []))
        self.store.put(note)
        return note

    def find(self, word: str) -> list[Note]:
        """Live notes that mention a word."""
        return [n for n in self.store.search(word) if not n.archived]

    def archive(self, slug: str) -> bool:
        """Hide a note from search without deleting it."""
        note = self.store.get(slug)
        if note is None:
            return False
        note.archived = True
        return True
