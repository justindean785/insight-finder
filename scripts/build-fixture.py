"""Assemble the harness fixture from raw REST dumps in src/dev/raw/.

Run after scripts/harness-snapshot.mjs (or an equivalent curl extraction) has
populated src/dev/raw/. Writes src/dev/fixtures.json, which is gitignored — it
holds real case data and must never be committed.
"""
import collections
import datetime
import json
import os
import sys

RAW = "src/dev/raw/"
THREAD_ID = sys.argv[1] if len(sys.argv) > 1 else None


def load(name):
    with open(os.path.join(RAW, name)) as fh:
        return json.load(fh)


threads = load("threads.json")
artifacts = load("artifacts.json")
messages = load("messages.json")
tools = load("tools.json")
evidence = load("evidence.json")
reviews = load("reviews.json")

thread_id = THREAD_ID or (artifacts[0]["thread_id"] if artifacts else threads[0]["id"])
owner = threads[0]["user_id"] if threads else None

snapshot = {
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "threadId": thread_id,
    "tables": {
        "threads": threads,
        "artifacts": artifacts,
        "messages": messages,
        "tool_usage_log": tools,
        "evidence_log": evidence,
        "artifact_reviews": reviews,
        "user_credits": [{"user_id": owner, "credits_remaining": 0, "credits_total": 0}],
        "agent_memory": [],
        "investigation_cache": [],
        "client_errors": [],
    },
    "user": {"id": owner},
}

with open("src/dev/fixtures.json", "w") as fh:
    json.dump(snapshot, fh)

# Profile the real distribution — this is what invented fixtures never show.
thread = next((t for t in threads if t["id"] == thread_id), None)
conf = [a["confidence"] for a in artifacts if a.get("confidence") is not None]
print("thread        ", (thread or {}).get("seed_value"), "| status:", (thread or {}).get("status"))
print("artifacts     ", len(artifacts), "| kinds:", collections.Counter(a["kind"] for a in artifacts).most_common(8))
print("confidence    ", "n=%d" % len(conf), "min=%s max=%s" % (min(conf), max(conf)) if conf else "none",
      "| NULL confidence:", len(artifacts) - len(conf))
print("tool calls    ", len(tools), "| failed:", sum(1 for t in tools if t.get("ok") is False))
print("messages      ", len(messages))
print("evidence_log  ", len(evidence), "rows for", len(artifacts), "artifacts")
print("reviews       ", len(reviews), collections.Counter(r.get("verdict") for r in reviews).most_common())
print("all threads   ", len(threads))
