"""A small command line: `python -m notes.cli add "Title" body…` or `find word`."""
import sys

from .service import NotesService


def main(argv: list[str] | None = None) -> int:
    """Run one command against a fresh in-memory store."""
    args = list(sys.argv[1:] if argv is None else argv)
    service = NotesService()
    if args[:1] == ["add"] and len(args) > 1:
        print(service.create(args[1], " ".join(args[2:])).slug)
        return 0
    if args[:1] == ["find"] and len(args) > 1:
        for note in service.find(args[1]):
            print(note.slug)
        return 0
    print("usage: notes add TITLE [BODY…] | notes find WORD", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
