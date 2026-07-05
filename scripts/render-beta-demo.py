#!/usr/bin/env python3
"""Render polished demo video from Cursor screen recording + render-plan.json."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SESSION = Path(
    "/opt/cursor/recording-staging/session-2026-07-05T10-50-58-872Z-tool_f91af5ad-b595-49ed-b530-310d5034e22/recording"
)
ARTIFACTS = Path("/opt/cursor/artifacts")
WORKDIR = ARTIFACTS / "video-build"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Map output-time ranges (seconds) to lower-third labels — tuned to walkthrough order.
LABELS = [
    (0, 4, "Landing"),
    (4, 8, "Sign In"),
    (8, 13, "Home Hub"),
    (13, 18, "New Investigation"),
    (18, 22, "Chat — Seed"),
    (22, 42, "Live Scan"),
    (42, 47, "Next Steps"),
    (47, 53, "Evidence — Board"),
    (53, 57, "Evidence — Table"),
    (57, 61, "Evidence — Clusters"),
    (61, 65, "Evidence — Timeline"),
    (65, 70, "Evidence — Pivots"),
    (70, 75, "Tools — Activity"),
    (75, 80, "Tools — Custody"),
    (80, 86, "Graph"),
    (86, 93, "Report"),
    (93, 99, "Insights"),
    (99, 108, "Agent Brain"),
    (108, 999, "Home Hub"),
]


def run(cmd: list[str], quiet: bool = False) -> None:
    if not quiet:
        print(">", " ".join(cmd[:8]), ("..." if len(cmd) > 8 else ""))
    subprocess.run(cmd, check=True)


def make_card(text: str, sub: str, out: Path) -> None:
    vf = (
        f"drawtext=fontfile={FONT_BOLD}:text='{text}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h/2)-80,"
        f"drawtext=fontfile={FONT_BOLD}:text='{sub}':fontsize=36:fontcolor=0x94a3b8:x=(w-text_w)/2:y=(h/2)+20"
    )
    run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x0a0f1a:s=1920x1080:d=3",
            "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", str(out),
        ],
        quiet=True,
    )


def label_at(t_sec: float) -> str:
    for start, end, label in LABELS:
        if start <= t_sec < end:
            return label
    return ""


def render_trimmed(plan_path: Path, src: Path, out: Path) -> None:
    plan = json.loads(plan_path.read_text())
    segments = plan["playback"]["segments"]
    WORKDIR.mkdir(parents=True, exist_ok=True)
    parts: list[Path] = []

    for i, seg in enumerate(segments):
        src_start = seg["sourceStartMs"] / 1000.0
        src_dur = seg["sourceDurationMs"] / 1000.0
        rate = seg["playbackRate"]
        out_dur = seg["outputDurationMs"] / 1000.0
        out_start = seg["outputStartMs"] / 1000.0

        label = label_at(out_start + out_dur / 2)
        part = WORKDIR / f"part_{i:03d}.mp4"

        vf_parts = [
            "scale=1920:1080:force_original_aspect_ratio=decrease",
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
            "setsar=1",
        ]
        if label:
            safe = label.replace(":", "\\:").replace("'", "'\\''")
            vf_parts.append(
                f"drawbox=x=40:y=h-100:w=iw-80:h=60:color=black@0.55:t=fill,"
                f"drawtext=fontfile={FONT_BOLD}:text='{safe}':fontsize=32:fontcolor=white:x=60:y=h-82"
            )
        vf = ",".join(vf_parts)

        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{src_start:.3f}",
            "-i", str(src),
            "-t", f"{src_dur:.3f}",
            "-vf", vf,
            "-filter:v", f"setpts=PTS/{rate}",
            "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-r", "30", "-t", f"{out_dur:.3f}",
            str(part),
        ]
        run(cmd, quiet=True)
        parts.append(part)

    list_file = WORKDIR / "trim_list.txt"
    list_file.write_text("\n".join(f"file '{p}'" for p in parts))
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out)], quiet=True)


def main() -> None:
    src = SESSION / "recording_render_proxy_1080p.mp4"
    plan = SESSION / "render-plan.json"
    intro = WORKDIR / "intro.mp4"
    outro = WORKDIR / "outro.mp4"
    trimmed = WORKDIR / "trimmed.mp4"
    raw_out = ARTIFACTS / "insight-finder-beta-demo-raw.mp4"
    final_out = ARTIFACTS / "insight-finder-beta-demo.mp4"

    WORKDIR.mkdir(parents=True, exist_ok=True)

    # Copy proxy as deliverable raw (re-encode to manageable size)
    print("Encoding deliverable raw recording (1080p, ~17 min)...")
    run(
        [
            "ffmpeg", "-y", "-i", str(src),
            "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
            "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-an",
            "-movflags", "+faststart", str(raw_out),
        ]
    )

    print("Building intro/outro cards...")
    make_card("Insight Finder", "Early-access beta preview", intro)
    make_card("Thank you", "Glad you are joining the beta", outro)

    print("Rendering trimmed walkthrough with lower-thirds...")
    render_trimmed(plan, src, trimmed)

    full_list = WORKDIR / "full.txt"
    full_list.write_text(
        "\n".join(f"file '{p}'" for p in [intro, trimmed, outro])
    )
    print("Concatenating final video...")
    run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(full_list),
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(final_out),
        ]
    )

    dur = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(final_out),
        ],
        text=True,
    ).strip()
    print(f"Done.\n  Raw:    {raw_out}\n  Final:  {final_out}\n  Length: {float(dur):.1f}s")


if __name__ == "__main__":
    main()
