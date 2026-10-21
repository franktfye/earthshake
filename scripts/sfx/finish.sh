#!/usr/bin/env bash
# Trim, fade, loudness-normalise and encode Stable Audio Open renders into
# public/audio/sfx/*.mp3. Usage: scripts/sfx/finish.sh <raw-wav-dir>
set -euo pipefail
RAW=${1:?raw dir}
OUT="$(cd "$(dirname "$0")/../.." && pwd)/public/audio/sfx"
mkdir -p "$OUT"
for f in "$RAW"/*.wav; do
  n=$(basename "$f" .wav)
  [[ "$n" == *_c[0-9] ]] && continue
  if [[ "$n" == rumble ]]; then
    # seamless loop built in numpy (ffmpeg concat after asplit is unreliable here)
    PY=${SFX_PYTHON:-python3}
    "$PY" -I "$(dirname "$0")/loop.py" "$f" "/tmp/$n.loop.wav" 2
    ffmpeg -loglevel error -y -i "/tmp/$n.loop.wav" -af "lowpass=f=900,loudnorm=I=-20:TP=-2" \
      -ac 1 -ar 44100 -b:a 96k "$OUT/$n.mp3"
    continue
  fi
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  fo=$(python3 -c "d=float('$dur');print(max(0.0,d-min(0.4,d*0.25)))")
  fl=$(python3 -c "d=float('$dur');print(min(0.4,d*0.25))")
  ffmpeg -loglevel error -y -i "$f" -af \
    "silenceremove=start_periods=1:start_threshold=-45dB,afade=t=out:st=$fo:d=$fl,loudnorm=I=-16:TP=-1.5" \
    -ac 1 -ar 44100 -b:a 112k "$OUT/$n.mp3"
done
ls -la "$OUT"
