"""Remembered uploads (`pipeline.stored_files`): bytes a deployment already
stores are not uploaded again; entries are per deployment, expire, and are
forgotten after a purge."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.stored_files import TTL, StoredFiles, stored_files_path

SITE = "https://happy-otter-123.convex.site"
OTHER = "https://other-deployment-456.convex.site"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 16
SHA = hashlib.sha256(PNG).hexdigest()


def test_the_path_sits_next_to_the_crosswalk(tmp_path: Path) -> None:
    assert stored_files_path(tmp_path / "var" / "staging") == (
        tmp_path / "var" / "state" / "stored-files.json"
    )


def test_known_bytes_are_not_uploaded_again(tmp_path: Path, net) -> None:
    route = net.post(f"{SITE}/api/pipeline/files").respond(
        200, json={"storageId": "kg2abc", "sha256": SHA, "inserted": 1}
    )
    path = tmp_path / "stored-files.json"
    loader = ConvexLoader(SITE, "test-key", max_retries=0)

    loader.stored_files = StoredFiles.load(path, loader.base_url)
    first = loader.upload_file(PNG, "image/png")
    loader.stored_files.save()
    loader.stored_files = StoredFiles.load(path, loader.base_url)  # the next run
    second = loader.upload_file(PNG, "image/png")

    assert first.storage_id == second.storage_id == "kg2abc"
    assert route.call_count == 1
    assert loader.stored_files.reused == 1
    # Another deployment's storage ids are its own.
    assert StoredFiles.load(path, OTHER).get(SHA) is None


def test_a_reply_for_other_bytes_is_not_remembered(tmp_path: Path, net) -> None:
    net.post(f"{SITE}/api/pipeline/files").respond(
        200, json={"storageId": "kg2abc", "sha256": "not-this", "inserted": 1}
    )
    loader = ConvexLoader(SITE, "test-key", max_retries=0)
    loader.stored_files = StoredFiles.load(tmp_path / "s.json", loader.base_url)
    loader.upload_file(PNG, "image/png")
    assert loader.stored_files.get(SHA) is None


def test_entries_expire_and_are_forgotten_after_a_purge(tmp_path: Path) -> None:
    path = tmp_path / "stored-files.json"
    now = datetime(2026, 10, 9, tzinfo=UTC)
    stored = StoredFiles.load(path, SITE)
    stored.put(SHA, "kg2abc", now=now)
    stored.save()
    other = StoredFiles.load(path, OTHER)
    other.put(SHA, "kg2zzz", now=now)
    other.save()

    assert StoredFiles.load(path, SITE).get(SHA, now=now + TTL - timedelta(days=1)) == "kg2abc"
    assert StoredFiles.load(path, SITE).get(SHA, now=now + TTL + timedelta(days=1)) is None

    StoredFiles.forget(path, SITE)
    assert StoredFiles.load(path, SITE).get(SHA, now=now) is None
    assert StoredFiles.load(path, OTHER).get(SHA, now=now) == "kg2zzz"


def test_a_dry_run_neither_reads_nor_writes_the_memory(tmp_path: Path) -> None:
    loader = ConvexLoader("", "", dry_run=True)
    loader.stored_files = StoredFiles.load(tmp_path / "s.json", "")
    assert loader.upload_file(PNG, "image/png").storage_id == "dry-run"
    assert loader.stored_files.entries == {}
