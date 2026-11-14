"""LOCAL DEV: mimic the ESP32 writer by inserting raw rows into water_levels (inches).

Depths are given in cm (like the backend thresholds) and converted to a raw distance
using the sensor's baseline, exactly what the ultrasonic sensor would report.

    python scripts/fake_writer.py --sensor water_tank_1 --depth 0          # dry road
    python scripts/fake_writer.py --sensor water_tank_1 --depth 30         # flooded
    python scripts/fake_writer.py --sensor water_tank_1 --ramp 0 30 60     # rise 0->30 cm over 60 s
"""
import argparse
import asyncio
import random
import time

import asyncpg


async def main() -> None:
    p = argparse.ArgumentParser()
    # Deliberately NOT reading .env: this script must only ever hit the local Docker DB.
    p.add_argument("--dsn", default="postgresql://postgres:password@localhost:5432/postgres")
    p.add_argument("--sensor", required=True)
    p.add_argument("--depth", type=float, help="hold a constant depth (cm)")
    p.add_argument("--ramp", nargs=3, type=float, metavar=("FROM", "TO", "SECONDS"))
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--count", type=int, default=0, help="stop after N readings (0 = forever)")
    p.add_argument("--noise", type=float, default=0.3, help="+/- cm of ultrasonic jitter")
    a = p.parse_args()
    if a.depth is None and a.ramp is None:
        p.error("give --depth or --ramp")

    con = await asyncpg.connect(a.dsn)
    baseline = await con.fetchval("SELECT baseline_cm FROM sensors WHERE sensor_id = $1", a.sensor)
    if baseline is None:
        raise SystemExit(f"unknown sensor {a.sensor!r} (or no baseline_cm)")

    t0, seq = time.monotonic(), 0
    while a.count == 0 or seq < a.count:
        if a.ramp:
            lo, hi, dur = a.ramp
            depth = lo + (hi - lo) * min(1.0, (time.monotonic() - t0) / dur)
        else:
            depth = a.depth
        distance_cm = max(0.0, baseline - depth + random.uniform(-a.noise, a.noise))
        await con.execute(
            "INSERT INTO water_levels (time, sensor_id, distance_inches) VALUES (now(), $1, $2)",
            a.sensor, distance_cm / 2.54,
        )
        print(f"#{seq} distance={distance_cm / 2.54:.2f}in (target depth {depth:.1f}cm)", flush=True)
        seq += 1
        await asyncio.sleep(a.interval)
    await con.close()


if __name__ == "__main__":
    asyncio.run(main())
