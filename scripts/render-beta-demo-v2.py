#!/usr/bin/env python3
"""Re-render polished demo — skips desktop/chrome junk, visible lower-thirds."""
from __future__ import annotations

import subprocess
from pathlib import Path

ARTIFACTS = Path("/opt/cursor/artifacts")
WORKDIR = ARTIFACTS / "video-build-v2"
SRC = Path(
    "/opt/cursor/recording-staging/session-2026-07-05T10-50-58-872Z-tool_f91af5ad-b595-49ed-b530-310d5034e22/recording/recording_render_proxy_1080p.mp4"
)
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# (start_sec, duration_sec, label, speed)
SEGMENTS = [
    (88, 5, "Landing", 1.0),
    (95, 6, "Sign In", 1.0),
    (158, 6, "Home Hub", 1.0),
    (175, 5, "New Investigation", 1.0),
    (188, 5, "Chat — Seed", 1.0),
    (198, 8, "Live Scan", 1.0),
    (250, 10, "Live Scan", 2.5),
    (380, 12, "Live Scan", 2.5),
    (418, 5, "Next Steps", 1.0),
    (430, 6, "Evidence — Board", 1.0),
    (450, 4, "Evidence — Table", 1.0),
    (468, 4, "Evidence — Clusters", 1.0),
    (482, 4, "Evidence — Timeline", 1.0),
    (498, 5, "Evidence — Pivots", 1.0),
    (520, 5, "Tools — Activity", 1.0),
    (545, 5, "Tools — Custody", 1.0),
    (575, 6, "Graph", 1.0),
    (610, 7, "Report", 1.0),
    (660, 5, "Insights", 1.0),
    (700, 5, "Agent Brain — Memories", 1.0),
    (740, 5, "Agent Brain — Patterns", 1.0),
    (780, 5, "Agent Brain — Sources", 1.0),
    (820, 5, "Agent Brain — Credits", 1.0),
    (860, 4, "Home Hub", 1.0),
]


def run(cmd: list[str]) -> None:
    print(">", " ".join(cmd[:12]), "...")
    subprocess.run(cmd, check=True)


def lower_third(label: str) -> str:
    safe = label.replace(":", "\\:").replace("'", "'\\''")
    return (
        "scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,"
        "drawbox=x=0:y=h-110:w=iw:h=90:color=0x0f172a@0.92:t=fill,"
        "drawbox=x=0:y=h-110:w=6:h=90:color=0x38bdf8@1:t=fill,"
        f"drawtext=fontfile={FONT_BOLD}:text='{safe}':fontsize=42:fontcolor=white:x=24:y=h-78"
    )


def make_card(text: str, sub: str, out: Path) -> None:
    vf = (
        f"drawtext=fontfile={FONT_BOLD}:text='{text}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h/2)-80,"
        f"drawtext=fontfile={FONT_BOLD}:text='{sub}':fontsize=36:fontcolor=0x94a3b8:x=(w-text_w)/2:y=(h/2)+20"
    )
    run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=0x0a0f1a:s=1920x1080:d=3",
            "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", str(out),
        ]
    )


def cut_segment(idx: int, start: float, dur: float, label: str, speed: float) -> Path:
    out = WORKDIR / f"seg_{idx:02d}.mp4"
    out_dur = dur / speed
    run(
        [
            "ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(SRC), "-t", f"{dur:.2f}",
            "-vf", lower_third(label), "-filter:v", f"setpts=PTS/{speed}",
            "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
            "-r", "30", "-t", f"{out_dur:.2f}", str(out),
        ]
    )
    return out


def main() -> None:
    WORKDIR.mkdir(parents=True, exist_ok=True)
    final_out = ARTIFACTS / "insight-finder-beta-demo.mp4"
    intro = WORKDIR / "intro.mp4"
    outro = WORKDIR / "outro.mp4"
    body = WORKDIR / "body.mp4"

    make_card("Insight Finder", "Early-access beta preview", intro)
    make_card("Thank you", "Glad you are joining the beta", outro)

    parts = [cut_segment(i, s, d, lbl, spd) for i, (s, d, lbl, spd) in enumerate(SEGMENTS)]
    seg_list = WORKDIR / "segments.txt"
    seg_list.write_text("\n".join(f"file '{p}'" for p in parts))
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(seg_list), "-c", "copy", str(body)])

    full = WORKDIR / "full.txt"
    full.write_text("\n".join(f"file '{p}'" for p in [intro, body, outro]))
    run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(full),
            "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
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
    print(f"Final: {final_out} ({float(dur):.0f}s, {final_out.stat().st_size/1_048_576:.1f} MB)")


if __name__ == "__main__":
    main()
