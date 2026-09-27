#!/usr/bin/env python3
"""Verify a published official release and emit a pin patch without editing Latch."""
import argparse
import base64
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("tag", help="an already published official vMAJOR.MINOR.PATCH tag; no version is assumed")
parser.add_argument("latch", type=Path, help="Latch checkout whose messages manifest will be compared")
args = parser.parse_args()
if not re.fullmatch(r"v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", args.tag):
    parser.error("pass a concrete version tag, such as the version chosen by the release maintainer")

root = Path(__file__).resolve().parent
repo = "plow-pbc/plow-messages"
def api(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/{endpoint}"]))

release = api(f"releases/tags/{quote(args.tag, safe='')}")
if release["draft"] or release["tag_name"] != args.tag:
    raise SystemExit("The requested tag is not a published official release.")
for name in ("plow-messages.swift", "plow-messages-bridge.h"):
    content = api(f"contents/{name}?ref={quote(args.tag, safe='')}")
    released = base64.b64decode(content["content"])
    reviewed = (root / "source" / name).read_bytes()
    if released != reviewed:
        raise SystemExit(f"Refusing to generate a pin: {name} differs from reviewed source 493614d; review and test that release first.")

version = args.tag[1:]
names = {"arm64": f"plow-messages_{version}_darwin_arm64.tar.gz", "x64": f"plow-messages_{version}_darwin_amd64.tar.gz"}
assets = {asset["name"]: asset for asset in release["assets"]}
for name in ["checksums.txt", *names.values()]:
    if name not in assets:
        raise SystemExit(f"Official release is incomplete: missing {name}")

hashes = {}
with tempfile.TemporaryDirectory(prefix="verified-official-", dir=root) as directory:
    command = ["gh", "release", "download", args.tag, "--repo", repo, "--dir", directory]
    for name in ["checksums.txt", *names.values()]:
        command += ["--pattern", name]
    subprocess.run(command, check=True)
    checksums = {}
    for line in (Path(directory) / "checksums.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", line)
        if not match or match[2] in checksums:
            raise SystemExit("Malformed or duplicate entries in official checksums.txt")
        checksums[match[2]] = match[1].lower()
    for arch, name in names.items():
        actual = hashlib.sha256((Path(directory) / name).read_bytes()).hexdigest()
        if checksums.get(name) != actual:
            raise SystemExit(f"Archive does not match official checksums.txt: {name}")
        github_digest = assets[name].get("digest")
        if github_digest and github_digest != f"sha256:{actual}":
            raise SystemExit(f"Archive does not match GitHub's asset digest: {name}")
        hashes[arch] = actual

manifest_path = args.latch.resolve() / "apps/desktop/plugins/messages/latch-plugin.json"
before = manifest_path.read_text()
manifest = json.loads(before)
binary = manifest["runtime"]["binaries"][0]
replacements = [(manifest["version"], version)]
for arch, name in names.items():
    replacements += [(binary["url"][arch], assets[name]["browser_download_url"]), (binary["sha256"][arch], hashes[arch])]
after = before
for old, new in replacements:
    if old == new:
        continue
    old_literal, new_literal = json.dumps(old), json.dumps(new)
    if after.count(old_literal) != 1:
        raise SystemExit("Manifest format changed; inspect the pin update manually.")
    after = after.replace(old_literal, new_literal, 1)
json.loads(after)
patch = "".join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile="a/apps/desktop/plugins/messages/latch-plugin.json", tofile="b/apps/desktop/plugins/messages/latch-plugin.json"))
(root / "official-pin.patch").write_text(patch)
(root / "latch-plugin.proposed.json").write_text(after)
(root / "official-release-verification.json").write_text(json.dumps({"tag": args.tag, "release": release["html_url"], "reviewed_source": "493614d4398c04754e6a5006f0eb78de16947b87", "source_bytes_match": True, "sha256": hashes, "prerelease": release["prerelease"]}, indent=2) + "\n")
print(patch or "The current manifest already matches this verified official release.")
print("Generated files only. Apply official-pin.patch, stage the plugin, and run validation before committing.")
