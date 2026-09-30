"""Run the Karyo MCP server over stdio (what Claude Desktop launches): `karyo-mcp`."""
from __future__ import annotations

import logging
import sys

from karyo_mcp.app import build


def main() -> None:
    # stdout belongs to the protocol on stdio: log to stderr only
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(name)s %(message)s")
    build().run()


if __name__ == "__main__":
    main()
