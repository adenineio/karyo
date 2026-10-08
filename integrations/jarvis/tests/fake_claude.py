"""A stand-in for `claude -p --input-format stream-json --output-format stream-json`: for each user
message it streams a text reply (partials, then the full block), a tool use when asked, and a result.
"die" makes it exit mid-turn. Its argv goes to $FAKE_CLAUDE_ARGV."""
import json
import os
import sys

if os.environ.get("FAKE_CLAUDE_ARGV"):
    with open(os.environ["FAKE_CLAUDE_ARGV"], "a") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}) + "\n")


def out(ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()


out({"type": "system", "subtype": "init", "tools": ["Read", "Grep", "Glob"]})
for line in sys.stdin:
    msg = json.loads(line)
    text = msg["message"]["content"][0]["text"]
    if "die" in text:
        sys.exit(3)
    if "focus" in text:
        out({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__karyo_view__focus", "input": {"target": "Pipeline tools"}}]},
            "parent_tool_use_id": None})
    words = ["You", " said:", " " + text.split("\n")[-1]]
    out({"type": "stream_event", "event": {"type": "message_start", "message": {}}})
    out({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
    for w in words:
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": w}}})
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "".join(words)}]}, "parent_tool_use_id": None})
    out({"type": "result", "subtype": "success", "is_error": False, "result": "".join(words)})
