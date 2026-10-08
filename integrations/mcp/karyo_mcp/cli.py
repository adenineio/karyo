"""Running the `karyo` CLI. Every piece of explainer logic lives there; this module only finds it,
runs it with `--json`, and turns its answers (or its errors) into Python values."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
from mcp.server.mcpserver.exceptions import ToolError

# integrations/mcp/karyo_mcp/cli.py -> the repo root
REPO = Path(__file__).resolve().parents[3]

# Claude Desktop starts servers without the login shell's PATH: add the usual homes of bun and Chrome's helpers.
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".bun/bin"), "/usr/bin", "/bin"]


class CliError(ToolError):
    """The CLI refused (bad input, a missing explainer): the message is for the model."""


@dataclass
class Karyo:
    """How to reach the CLI, and the workspace it works in."""

    command: list[str]
    workspace: Path
    components: Path
    env: dict[str, str] = field(default_factory=dict)
    timeout: float = 200.0  # Claude Desktop gives a tool call 240 s
    setup_timeout: float = 230.0  # check_setup may download a browser
    output_dir: str | None = None  # $KARYO_OUTPUT_DIR: where build_explainer saves a copy by default

    @classmethod
    def from_env(cls) -> Karyo:
        ws = Path(os.environ.get("KARYO_WORKSPACE") or Path.home() / ".adenine/karyo/explainers").expanduser()
        comps = Path(os.environ.get("KARYO_COMPONENTS") or ws / "components").expanduser()
        out = (os.environ.get("KARYO_OUTPUT_DIR") or "").strip() or None
        return cls(command=resolve_command(), workspace=ws, components=comps, output_dir=out)

    def spec_path(self, explainer_id: str) -> Path:
        return self.workspace / explainer_id / f"{explainer_id}.explainer.json"

    def environment(self) -> dict[str, str]:
        env = {**os.environ, **self.env}
        path = dict.fromkeys([*env.get("PATH", "").split(os.pathsep), *EXTRA_PATH])
        env["PATH"] = os.pathsep.join(p for p in path if p)
        # workspace-wide components come after an explainer's own; set only when there are some, since
        # with it set the CLI renders through a private dev server (see renderServer in cli/karyo.ts)
        if self.components.is_dir():
            env["KARYO_COMPONENTS"] = str(self.components)
        return env

    async def run(self, *args: str, ok_codes: tuple[int, ...] = (0,), timeout: float | None = None) -> Any:
        """Run `karyo <args> --json` and return its JSON answer. Exit 1 (validation errors) is an
        answer when `ok_codes` allows it; exit 2 or an `{"error": …}` reply becomes a CliError."""
        argv = [*self.command, *args, "--json"]
        try:
            with anyio.fail_after(timeout or self.timeout):
                cwd = self.workspace if self.workspace.is_dir() else Path(tempfile.gettempdir())
                p = await anyio.run_process(argv, check=False, env=self.environment(), cwd=str(cwd))
        except TimeoutError as e:
            raise CliError(f"karyo {args[0]} took longer than {timeout or self.timeout:.0f} s" + ("; try fewer steps" if args[0] == "stills" else "; a first run may still be setting up, so try again")) from e
        except FileNotFoundError as e:
            raise CliError(f"can't run the karyo CLI ({argv[0]}: {e.strerror}); set KARYO_BIN to cli/karyo.ts in a Karyo checkout") from e
        out, err = p.stdout.decode(errors="replace").strip(), p.stderr.decode(errors="replace").strip()
        try:
            data = json.loads(out) if out else None
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict) and "error" in data and len(data) == 1:
            raise CliError(str(data["error"]))
        if p.returncode not in ok_codes or data is None:
            raise CliError(f"karyo {args[0]} failed (exit {p.returncode}): {(err or out)[-2000:]}")
        return data


def resolve_command() -> list[str]:
    """`KARYO_BIN` (a karyo executable, or cli/karyo.ts) or the checkout this package sits in."""
    target = os.environ.get("KARYO_BIN") or str(REPO / "cli/karyo.ts")
    if target.endswith(".ts"):
        return [find_bun(), target]
    if target.endswith(".py"):
        return [sys.executable, target]
    return [target]


def find_bun() -> str:
    for c in (os.environ.get("BUN"), shutil.which("bun"), "/opt/homebrew/bin/bun", str(Path.home() / ".bun/bin/bun"),
              "/usr/local/bin/bun"):
        if c and Path(c).exists():
            return c
    return "bun"
