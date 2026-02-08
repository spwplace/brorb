#!/usr/bin/env python3
"""Brorb - A breathing orb driven by a brainstem CPG model."""

import asyncio
import argparse
import signal

from brorb.server import run_server


def main():
    parser = argparse.ArgumentParser(description="Brorb breathing orb server")
    parser.add_argument("--port", type=int, default=8765, help="Server port (default: 8765)")
    parser.add_argument("--no-mic", action="store_true", help="Disable microphone input")
    parser.add_argument("--bpm", type=float, default=4.0, help="Target breaths per minute (default: 4)")
    args = parser.parse_args()

    loop = asyncio.new_event_loop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, loop.stop)

    print(f"Starting Brorb on http://localhost:{args.port}")
    print(f"  Target rate: {args.bpm} breaths/min")
    print(f"  Microphone: {'disabled' if args.no_mic else 'enabled'}")

    try:
        loop.run_until_complete(run_server(
            port=args.port,
            use_mic=not args.no_mic,
            target_bpm=args.bpm,
        ))
        loop.run_forever()
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
