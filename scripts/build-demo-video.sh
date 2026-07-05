#!/usr/bin/env bash
# Build polished beta demo video from raw screen recording.
# Usage: ./scripts/build-demo-video.sh <raw_recording.mp4> [output.mp4]
set -euo pipefail

RAW="${1:?raw recording path required}"
OUT="${2:-/opt/cursor/artifacts/insight-finder-beta-demo.mp4}"
WORKDIR="/opt/cursor/artifacts/video-build"
FONT="/usr/share/fonts/truetype/macos/Inter-SemiBoldItalic.ttf"
FONT_REG="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

mkdir -p "$WORKDIR"

# --- Intro / outro cards (1080p, 3s each) ---
make_card() {
  local text="$1" sub="$2" out="$3"
  ffmpeg -y -f lavfi -i "color=c=0x0a0f1a:s=1920x1080:d=3" \
    -vf "drawtext=fontfile=${FONT_BOLD}:text='${text}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h/2)-80,
         drawtext=fontfile=${FONT_REG}:text='${sub}':fontsize=36:fontcolor=0x94a3b8:x=(w-text_w)/2:y=(h/2)+20" \
    -c:v libx264 -pix_fmt yuv420p -r 30 "$out" 2>/dev/null
}

make_card "Insight Finder" "Early-access beta preview" "$WORKDIR/intro.mp4"
make_card "Thank you" "We are glad you are joining the beta" "$WORKDIR/outro.mp4"

# --- Normalize raw to 1080p 30fps, trim black/idle start if any ---
ffmpeg -y -i "$RAW" \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" \
  -r 30 -c:v libx264 -preset fast -crf 20 -an \
  "$WORKDIR/raw_norm.mp4" 2>/dev/null

# --- Segment definitions: start_sec duration label ---
# These are tuned after recording; override via segments.txt if present.
SEG_FILE="$WORKDIR/segments.txt"
if [[ ! -f "$SEG_FILE" ]]; then
  cat > "$SEG_FILE" <<'EOF'
0 5 Landing
5 6 Sign In
11 5 Home Hub
16 4 New Investigation
20 3 Chat — Seed
23 18 Live Scan
41 4 Evidence — Board
45 3 Evidence — Table
48 3 Evidence — Clusters
51 3 Evidence — Timeline
54 4 Evidence — Pivots
58 3 Tools — Activity
61 3 Tools — Custody
64 4 Graph
68 5 Report
73 4 Insights
77 5 Agent Brain
EOF
fi

# Build trimmed segments with lower-thirds
SEG_LIST="$WORKDIR/concat_list.txt"
: > "$SEG_LIST"
IDX=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  read -r START DUR LABEL <<< "$line"
  OUT_SEG="$WORKDIR/seg_${IDX}.mp4"
  # Escape label for drawtext
  SAFE_LABEL=$(echo "$LABEL" | sed "s/'/'\\\\''/g" | sed 's/:/\\:/g')
  ffmpeg -y -ss "$START" -i "$WORKDIR/raw_norm.mp4" -t "$DUR" \
    -vf "drawbox=x=40:y=h-100:w=iw-80:h=60:color=black@0.55:t=fill,
         drawtext=fontfile=${FONT_BOLD}:text='${SAFE_LABEL}':fontsize=32:fontcolor=white:x=60:y=h-82" \
    -c:v libx264 -preset fast -crf 20 -r 30 -an "$OUT_SEG" 2>/dev/null
  echo "file '$OUT_SEG'" >> "$SEG_LIST"
  IDX=$((IDX + 1))
done < "$SEG_FILE"

# Concat intro + segments + outro
FULL_LIST="$WORKDIR/full_concat.txt"
{
  echo "file '$WORKDIR/intro.mp4'"
  cat "$SEG_LIST"
  echo "file '$WORKDIR/outro.mp4'"
} > "$FULL_LIST"

ffmpeg -y -f concat -safe 0 -i "$FULL_LIST" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart \
  "$OUT" 2>/dev/null

echo "Wrote $OUT"
ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT" | xargs -I{} echo "Duration: {}s"
