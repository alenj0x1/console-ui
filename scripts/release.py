"""Cuts a release: bumps the version everywhere, turns the changelog's
Unreleased / Sin publicar sections into the version, commits
"chore(release): X.Y.Z" and creates the annotated tag vX.Y.Z with the notes
(English, then Spanish). It does not push.

Usage:
  python scripts/release.py X.Y.Z [--dry-run]
  python scripts/release.py --next      suggest the next version from commits
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOGS = {"en": (ROOT / "CHANGELOG.md", "Unreleased"), "es": (ROOT / "CHANGELOG.es.md", "Sin publicar")}
CARGO = ROOT / "Cargo.toml"
TAURI = ROOT / "app" / "tauri.conf.json"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def current_version() -> str:
    m = re.search(r'\[workspace\.package\][^\[]*?version = "([^"]+)"', CARGO.read_text(encoding="utf-8"))
    if not m:
        sys.exit("No version in [workspace.package]")
    return m.group(1)


def suggest_next() -> str:
    major, minor, patch = map(int, current_version().split("."))
    try:
        last = git("describe", "--tags", "--abbrev=0")
        log = git("log", f"{last}..HEAD", "--format=%s%n%b")
    except subprocess.CalledProcessError:
        return current_version()  # nothing released yet: release the current version
    breaking = "BREAKING CHANGE" in log or re.search(r"^\w+(\(.+\))?!:", log, re.M)
    feat = re.search(r"^feat(\(.+\))?:", log, re.M)
    if breaking:
        return f"{major + 1}.0.0" if major else f"0.{minor + 1}.0"
    if feat:
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def remote_base() -> str | None:
    try:
        url = git("remote", "get-url", "origin")
    except subprocess.CalledProcessError:
        return None
    m = re.search(r"github\.com[:/](.+?)(\.git)?$", url)
    return f"https://github.com/{m.group(1)}" if m else None


def close_section(text: str, heading: str, version: str, date: str, base: str | None, previous: str) -> tuple[str, str]:
    """Turns the pending section into the version; returns (new text, notes)."""
    m = re.search(rf"^## \[{re.escape(heading)}\]\n(.*?)(?=^## \[|\Z)", text, re.M | re.S)
    if not m or not m.group(1).strip():
        sys.exit(f"Nothing under [{heading}]")
    notes = m.group(1).strip()
    text = text[: m.start()] + f"## [{version}] - {date}\n\n{notes}\n\n" + text[m.end():]
    text = re.sub(rf"^\[{re.escape(heading)}\]: .*\n?", "", text, flags=re.M)
    if base:
        link = f"{base}/compare/v{previous}...v{version}" if previous != version else f"{base}/releases/tag/v{version}"
        text = text.rstrip("\n") + f"\n[{version}]: {link}\n"
    return text, notes


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("version", nargs="?")
    ap.add_argument("--next", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.next:
        print(suggest_next())
        return
    if not args.version or not SEMVER.match(args.version):
        sys.exit("Give a version X.Y.Z (or --next)")
    if git("status", "--porcelain"):
        sys.exit("Working tree is not clean")
    version, previous = args.version, current_version()
    date = datetime.date.today().isoformat()
    base = remote_base()

    changes: dict[Path, str] = {}
    notes = {}
    for lang, (path, heading) in CHANGELOGS.items():
        changes[path], notes[lang] = close_section(path.read_text(encoding="utf-8"), heading, version, date, base, previous)
    cargo = CARGO.read_text(encoding="utf-8")
    changes[CARGO] = re.sub(r'(\[workspace\.package\][^\[]*?version = ")[^"]+(")', rf"\g<1>{version}\g<2>", cargo, count=1)
    tauri = json.loads(TAURI.read_text(encoding="utf-8"))
    tauri["version"] = version
    changes[TAURI] = json.dumps(tauri, indent=2, ensure_ascii=False) + "\n"

    message = f"v{version}\n\n{notes['en']}\n\n---\n\n{notes['es']}\n"
    if args.dry_run:
        print(f"{previous} -> {version}\n\n{message}")
        return
    for path, text in changes.items():
        path.write_text(text, encoding="utf-8", newline="\n")
    subprocess.run(["cargo", "update", "--workspace"], cwd=ROOT, check=True)
    git("add", "-A")
    git("commit", "-m", f"chore(release): {version}")
    git("tag", "-a", f"v{version}", "-m", message)
    print(f"Released {version} (commit + tag v{version}). Push with: git push --follow-tags")


if __name__ == "__main__":
    main()
