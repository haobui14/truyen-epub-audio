import asyncio
import io

from app.services import storage_service as storage


class FakeS3:
    def __init__(self):
        self.objects: dict[tuple[str, str], dict] = {}

    def put_object(self, **kwargs):
        self.objects[(kwargs["Bucket"], kwargs["Key"])] = {
            "body": bytes(kwargs["Body"]),
            "content_type": kwargs["ContentType"],
            "cache_control": kwargs.get("CacheControl"),
        }
        return {}

    def get_object(self, **kwargs):
        obj = self.objects[(kwargs["Bucket"], kwargs["Key"])]
        return {"Body": io.BytesIO(obj["body"])}

    def delete_objects(self, **kwargs):
        for item in kwargs["Delete"]["Objects"]:
            self.objects.pop((kwargs["Bucket"], item["Key"]), None)
        return {}

    def list_objects_v2(self, **kwargs):
        bucket = kwargs["Bucket"]
        prefix = kwargs["Prefix"]
        folders: set[str] = set()
        contents: list[dict] = []
        for (object_bucket, key), obj in self.objects.items():
            if object_bucket != bucket or not key.startswith(prefix):
                continue
            remainder = key[len(prefix):]
            if "/" in remainder:
                folders.add(prefix + remainder.split("/", 1)[0] + "/")
            else:
                contents.append({
                    "Key": key,
                    "Size": len(obj["body"]),
                    "ETag": f'"etag-{key}"',
                })
        return {
            "CommonPrefixes": [{"Prefix": item} for item in sorted(folders)],
            "Contents": sorted(contents, key=lambda item: item["Key"]),
            "IsTruncated": False,
        }


def configure(monkeypatch):
    fake = FakeS3()
    monkeypatch.setattr(storage.settings, "r2_endpoint_url", "https://account.r2.example")
    monkeypatch.setattr(storage.settings, "r2_access_key_id", "access")
    monkeypatch.setattr(storage.settings, "r2_secret_access_key", "secret")
    monkeypatch.setattr(storage.settings, "r2_public_bucket_name", "public-media")
    monkeypatch.setattr(storage.settings, "r2_private_bucket_name", "private-data")
    monkeypatch.setattr(storage.settings, "r2_public_url", "https://media.example.com/")
    monkeypatch.setattr(storage, "_storage_client", fake)
    return fake


def test_public_and_private_bucket_routing(monkeypatch):
    fake = configure(monkeypatch)

    cover_url = asyncio.run(
        storage.upload_bytes("covers", "book one/cover.webp", b"cover", "image/webp")
    )
    private_url = asyncio.run(
        storage.upload_bytes("epub-uploads", "book/original.epub", b"epub")
    )

    assert cover_url == "https://media.example.com/covers/book%20one/cover.webp"
    assert private_url == "r2://private-data/epub-uploads/book/original.epub"
    assert ("public-media", "covers/book one/cover.webp") in fake.objects
    assert ("private-data", "epub-uploads/book/original.epub") in fake.objects


def test_chapter_text_round_trip_is_gzipped(monkeypatch):
    fake = configure(monkeypatch)

    path = asyncio.run(storage.upload_chapter_text("book-id", "chapter-id", "Xin chào"))
    raw = fake.objects[("private-data", f"chapter-text/{path}")]["body"]

    assert raw.startswith(b"\x1f\x8b")
    assert asyncio.run(storage.download_chapter_text(path)) == "Xin chào"


def test_list_and_delete_logical_folder(monkeypatch):
    fake = configure(monkeypatch)
    for name in ("one.txt", "two.txt"):
        storage._sync_upload("chapter-text", f"book-a/{name}", name.encode(), "text/plain")
    storage._sync_upload("chapter-text", "book-b/three.txt", b"three", "text/plain")

    root = storage._sync_list("chapter-text", "")
    files = storage._sync_list("chapter-text", "book-a")

    assert [(item["name"], item["id"]) for item in root] == [
        ("book-a", None),
        ("book-b", None),
    ]
    assert [item["name"] for item in files] == ["one.txt", "two.txt"]

    asyncio.run(storage.delete_folder("chapter-text", "book-a"))
    assert ("private-data", "chapter-text/book-a/one.txt") not in fake.objects
    assert ("private-data", "chapter-text/book-a/two.txt") not in fake.objects
    assert ("private-data", "chapter-text/book-b/three.txt") in fake.objects
