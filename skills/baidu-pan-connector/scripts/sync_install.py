#!/usr/bin/env python3
"""Deploy or verify a Baidu Pan Connector skill installation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = ".baidu-pan-connector-install.json"
TASK_TEMPLATES = {
    ".gitkeep",
    "example-mkdir.json",
    "example-upload.json",
    "example-download.json",
}


def default_install_dir() -> Path:
    codex_home = Path(os.environ.get("CODEX_HOME", "")).expanduser() if os.environ.get("CODEX_HOME") else Path.home() / ".codex"
    return codex_home / "skills" / "baidu-pan-connector"


def is_source_file(path: Path) -> bool:
    rel = path.relative_to(SKILL_ROOT)
    return is_managed_relative(rel) and path.is_file()


def is_managed_relative(rel: Path) -> bool:
    if any(part in {"__pycache__", "state", "crawl-cache", "index-out", "dist"} for part in rel.parts):
        return False
    if rel.suffix.lower() in {".pyc", ".pyo"} or rel.name.endswith(".log"):
        return False
    if rel.parts and rel.parts[0] == "tasks" and rel.name not in TASK_TEMPLATES:
        return False
    return True


def source_files() -> dict[str, Path]:
    return {
        path.relative_to(SKILL_ROOT).as_posix(): path
        for path in sorted(SKILL_ROOT.rglob("*"))
        if is_source_file(path)
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expected_manifest() -> dict[str, str]:
    return {rel: sha256(path) for rel, path in source_files().items()}


def install(source: dict[str, Path], target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for rel, source_path in source.items():
        destination = target / Path(rel)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
    payload = {
        "schema": "baidu-pan-connector-install/v1",
        "source": str(SKILL_ROOT),
        "files": {rel: sha256(path) for rel, path in source.items()},
    }
    (target / MANIFEST_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def check(target: Path) -> list[str]:
    expected = expected_manifest()
    errors: list[str] = []
    if not target.is_dir():
        return [f"installation directory is missing: {target}"]
    for rel, expected_hash in expected.items():
        installed = target / Path(rel)
        if not installed.is_file():
            errors.append(f"missing: {rel}")
        elif sha256(installed) != expected_hash:
            errors.append(f"content differs: {rel}")

    actual = {
        path.relative_to(target).as_posix()
        for path in target.rglob("*")
        if path.is_file()
        and path.name != MANIFEST_NAME
        and is_managed_relative(path.relative_to(target))
    }
    for rel in sorted(actual - set(expected)):
        errors.append(f"unexpected unmanaged file: {rel}")
    return errors


def source_link_error(entry: Path) -> str | None:
    """Return an error unless a distinct install entry resolves to this source.

    Comparing resolved paths works for POSIX symlinks and Windows directory
    junctions without depending on elevated symlink privileges.
    """

    source = SKILL_ROOT.resolve()
    if not entry.exists():
        return f"installation entry is missing: {entry}"
    if entry.absolute() == source:
        return "installation entry is the source directory itself, not a distinct link"
    try:
        resolved = entry.resolve(strict=True)
    except OSError as error:
        return f"installation entry cannot be resolved: {entry}: {error}"
    if resolved != source:
        return f"installation entry does not resolve to source: {entry} -> {resolved}; expected {source}"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, default=default_install_dir())
    parser.add_argument("--apply", action="store_true", help="copy the managed source files")
    parser.add_argument("--check", action="store_true", help="verify byte-for-byte consistency")
    parser.add_argument(
        "--require-source-link",
        action="store_true",
        help="also require the install entry to resolve directly to this source tree",
    )
    args = parser.parse_args()
    if not args.apply and not args.check:
        parser.error("choose --apply, --check, or both")
    if args.require_source_link and not args.check:
        parser.error("--require-source-link requires --check")

    # Keep the requested path separate from its resolved target so strict
    # source-link validation can distinguish a junction from the source itself.
    target = args.install_dir.expanduser().absolute()
    resolved_target = target.resolve(strict=False)
    source = SKILL_ROOT.resolve()
    if args.apply and resolved_target == source:
        print(f"install target already resolves to source: {source}")
    elif args.apply:
        install(source_files(), target)
        print(f"installed managed files: {target}")

    if args.check:
        errors = check(target)
        if args.require_source_link:
            link_error = source_link_error(target)
            if link_error:
                errors.insert(0, link_error)
        if errors:
            for error in errors:
                print(f"[FAIL] {error}", file=sys.stderr)
            return 1
        print(f"install/source consistency: PASS ({target})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
