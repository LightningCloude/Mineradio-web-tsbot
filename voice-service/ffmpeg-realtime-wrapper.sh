#!/bin/sh
set -eu

# The voice service consumes audio at real-time cadence. Force ffmpeg to read
# every input at the native media rate so a remote CDN cannot be drained as
# fast as the network allows. The full source build also applies this option;
# this wrapper lets an incremental production image receive the fix without
# rebuilding the complete Rust dependency tree.
exec /usr/bin/ffmpeg -re "$@"
