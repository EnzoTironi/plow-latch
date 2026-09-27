#!/bin/sh
set -eu
review_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir="$review_dir/source"
source_sha=$(cat "$review_dir/source-sha.txt")
snapshot="review-$(printf '%s' "$source_sha" | cut -c1-7)"
mkdir -p "$review_dir/assets"
cd "$source_dir"
for entry in arm64:arm64 amd64:x86_64; do
  asset_arch=${entry%:*}
  target_arch=${entry#*:}
  build_dir="$review_dir/builds/$asset_arch"
  mkdir -p "$build_dir"
  swiftc -O -target "$target_arch-apple-macos13.0" -import-objc-header plow-messages-bridge.h plow-messages.swift -o "$build_dir/plow-messages"
  COPYFILE_DISABLE=1 tar -czf "$review_dir/assets/plow-messages_${snapshot}_darwin_${asset_arch}.tar.gz" -C "$build_dir" plow-messages
done
cd "$review_dir/assets"
shasum -a 256 "plow-messages_${snapshot}_darwin_arm64.tar.gz" "plow-messages_${snapshot}_darwin_amd64.tar.gz" > checksums.txt
cat checksums.txt
