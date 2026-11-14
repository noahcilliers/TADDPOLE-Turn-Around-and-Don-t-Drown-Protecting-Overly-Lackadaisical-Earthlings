"""Tiny WebSocket client that plays a driver: requests a route and prints every event.

    python scripts/ws_client.py --url ws://localhost:8000/ws \
        --from 33.5050,-111.9960 --to 33.5150,-111.9960
"""
import argparse
import asyncio
import json

import websockets


def ll(s):
    lat, lon = (float(x) for x in s.split(","))
    return {"lat": lat, "lon": lon}


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://localhost:8000/ws")
    p.add_argument("--from", dest="orig", required=True)
    p.add_argument("--to", dest="dest", required=True)
    p.add_argument("--seconds", type=float, default=0, help="exit after N seconds (0 = forever)")
    a = p.parse_args()
    async with websockets.connect(a.url) as ws:
        await ws.send(json.dumps({"type": "set_route", "origin": ll(a.orig), "destination": ll(a.dest)}))

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] == "route" and m.get("route"):
                    pr = m["route"]["properties"]
                    print(f"ROUTE[{m['reason']}] {pr['distance_m']:.0f} m, {pr['duration_s']:.0f} s, "
                          f"on_route={pr['sensors_on_route']} avoided={pr['avoided_sensors']} msg={m.get('message')}", flush=True)
                elif m["type"] == "alert":
                    print(f"ALERT[{m['alert']['severity']}] {m['alert']['message']}", flush=True)
                elif m["type"] == "sensor_update":
                    s = m["sensor"]
                    print(f"SENSOR {s['sensor_id']} {s['status']} depth={s['depth_cm']} rise={s['rise_cm_per_min']}", flush=True)
                else:
                    print(m["type"].upper(), json.dumps(m)[:200], flush=True)

        if a.seconds:
            try:
                await asyncio.wait_for(reader(), a.seconds)
            except asyncio.TimeoutError:
                pass
        else:
            await reader()


if __name__ == "__main__":
    asyncio.run(main())
