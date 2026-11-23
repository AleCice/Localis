#!/usr/bin/env bash
# Regenerates the synthetic lecture fixtures used by the 0.5 tests (no real recordings).
# Requires espeak-ng and ffmpeg (test-time tools only: the app never uses them).
# Output: lezione.mp3, lezione.m4a, lezione.mp4 (Italian TTS speech, ~9.5 s, < 50 KB each)
# and muto.mp4 (2 s of video without an audio track).
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
text="Buongiorno a tutti. Oggi parliamo della derivata di una funzione. La derivata misura la velocità di variazione."
espeak-ng -v it -s 140 -w "$tmp/speech.wav" "$text"
# One second of silence before the speech, so segment timestamps are not all zero.
ffmpeg -loglevel error -y -f lavfi -t 1 -i anullsrc=r=22050:cl=mono -i "$tmp/speech.wav" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" -ar 22050 -ac 1 "$tmp/lezione.wav"
ffmpeg -loglevel error -y -i "$tmp/lezione.wav" -map_metadata -1 -c:a libmp3lame -b:a 32k lezione.mp3
ffmpeg -loglevel error -y -i "$tmp/lezione.wav" -map_metadata -1 -c:a aac -b:a 32k lezione.m4a
ffmpeg -loglevel error -y -f lavfi -i color=c=navy:s=64x48:r=5 -i "$tmp/lezione.wav" -shortest \
  -map_metadata -1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart lezione.mp4
ffmpeg -loglevel error -y -f lavfi -i color=c=gray:s=32x24:r=2 -t 2 -map_metadata -1 \
  -c:v libx264 -pix_fmt yuv420p muto.mp4
ls -l lezione.* muto.mp4
