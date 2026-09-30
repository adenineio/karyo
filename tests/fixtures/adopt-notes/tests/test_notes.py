from notes import NotesService
from notes.models import slugify


def test_slugify():
    assert slugify("Buy milk, eggs!") == "buy-milk-eggs"


def test_create_and_find():
    service = NotesService()
    service.create("Weekly plan", "call the plumber", tags=["home"])
    service.create("Reading list", "a book about bridges")
    assert [n.slug for n in service.find("plumber")] == ["weekly-plan"]
    assert [n.slug for n in service.find("home")] == ["weekly-plan"]


def test_archive_hides_from_search():
    service = NotesService()
    note = service.create("Old idea", "bridges again")
    assert service.archive(note.slug)
    assert service.find("bridges") == []
