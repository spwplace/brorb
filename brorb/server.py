"""
WebSocket server + static file serving.

Streams simulation state at ~60Hz to connected browser clients
and serves the web/ directory for the orb visualization.
"""

import asyncio
import json
import os

from aiohttp import web

from .sim import Simulation


class BrorbServer:
    """Combined HTTP + WebSocket server."""

    def __init__(self, sim, port=8765):
        self.sim = sim
        self.port = port
        self.ws_clients = set()
        self._web_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")

    async def _ws_handler(self, request):
        """Handle WebSocket connections via aiohttp."""
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.ws_clients.add(ws)
        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._handle_control(data)
                    except json.JSONDecodeError:
                        pass
                elif msg.type == web.WSMsgType.ERROR:
                    break
        finally:
            self.ws_clients.discard(ws)
        return ws

    async def _handle_control(self, data):
        """Handle control messages from clients."""
        if "target_bpm" in data:
            bpm = float(data["target_bpm"])
            if 1.0 <= bpm <= 30.0:
                from .cpg import default_params
                self.sim.cpg_params = default_params(bpm)
                print(f"Target BPM changed to {bpm}")

        if "entrain_strength" in data:
            strength = float(data["entrain_strength"])
            self.sim.entrain_strength = max(0.0, min(2.0, strength))

    async def _broadcast_loop(self):
        """Read sim states and broadcast to all WebSocket clients."""
        while True:
            state = await self.sim.get_state()
            if not self.ws_clients:
                continue

            msg = json.dumps(state.to_dict())
            dead = set()
            for ws in self.ws_clients:
                try:
                    await ws.send_str(msg)
                except (ConnectionError, ConnectionResetError):
                    dead.add(ws)
            self.ws_clients -= dead

    async def _index_handler(self, request):
        """Serve index.html."""
        path = os.path.join(self._web_dir, "index.html")
        return web.FileResponse(path)

    def _setup_routes(self, app):
        """Set up HTTP routes."""
        app.router.add_get("/", self._index_handler)
        app.router.add_get("/ws", self._ws_handler)
        app.router.add_static("/", self._web_dir, show_index=False)


async def run_server(port=8765, use_mic=True, target_bpm=4.0):
    """Start the simulation and server."""
    sim = Simulation(target_bpm=target_bpm, use_mic=use_mic)

    server = BrorbServer(sim, port)

    app = web.Application()
    server._setup_routes(app)

    # Start simulation in background
    sim_task = asyncio.ensure_future(sim.run())

    # Start broadcast loop
    broadcast_task = asyncio.ensure_future(server._broadcast_loop())

    # Start HTTP server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    print(f"Server running at http://localhost:{port}")

    # Keep running
    try:
        await asyncio.gather(sim_task, broadcast_task)
    except asyncio.CancelledError:
        pass
    finally:
        await sim.stop()
        await runner.cleanup()
