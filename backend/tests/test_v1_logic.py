"""Pure-logic tests for the v1 features: steps, analytics, demo timing, profile replay, route selection."""
from datetime import datetime, timedelta, timezone

import networkx as nx
import pytest

from app.analytics import fill_buckets, parse_since, series_window, stats_from_minutes
from app.demo import current_demo_s, interpolate
from app.routing import RoadNetwork
from app.simulator import csv_time_for, profile_value
from app.steps import Leg, build_steps, cardinal, road_name
from app.v1routes import build_routes

T0 = datetime(2026, 11, 14, 20, 0, tzinfo=timezone.utc)


# ---------------- steps ----------------
def test_road_name_variants():
    assert road_name("N 40th St") == "N 40th St"
    assert road_name(["E Camelback Rd", "AZ-1"]) == "E Camelback Rd"
    assert road_name("['E Thomas Rd', 'x']") == "E Thomas Rd"
    assert road_name(None) == "unnamed road"
    assert road_name("") == "unnamed road"


def test_steps_group_and_turn():
    legs = [
        Leg("N 40th St", 300, 0, 0), Leg("N 40th St", 200, 0, 0),      # merged
        Leg("E Campbell Ave", 800, 90, 90),                             # right turn
        Leg("N 44th St", 1500, 0, 2),                                   # left turn
        Leg("N 44th St Ext", 100, 15, 15),                              # continue
    ]
    s = build_steps(legs)
    assert [x["instruction"] for x in s] == [
        "Head north on N 40th St", "Turn right onto E Campbell Ave",
        "Turn left onto N 44th St", "Continue onto N 44th St Ext",
    ]
    assert s[0]["distance_m"] == 500


def test_cardinal():
    assert cardinal(0) == "north" and cardinal(91) == "east" and cardinal(200) == "south" and cardinal(350) == "north"


# ---------------- analytics ----------------
def test_series_window_and_fill():
    start, bucket = series_window(T0, "1h")
    assert bucket == 30 and start == T0 - timedelta(hours=1)
    pts = fill_buckets({0: 1.23, 119: 40.0}, start, bucket)
    assert len(pts) == 120
    assert pts[0]["depth_cm"] == 1.2 and pts[1]["depth_cm"] is None and pts[119]["depth_cm"] == 40.0
    assert series_window(T0, "24h")[1] == 720


def test_stats_math():
    minutes = [1, 1, 1, 1, 1, 6, 11, 16, 16, None, 4]
    st = stats_from_minutes(minutes, T0, caution_cm=5, flooded_cm=15)
    assert st["peak_cm"] == 16 and st["peak_at"] == (T0 + timedelta(minutes=7)).isoformat()
    assert st["fastest_rise_cm_per_min"] == 3.0          # (16 - 1) / 5
    assert st["minutes_above_caution"] == 4 and st["minutes_flooded"] == 2
    empty = stats_from_minutes([None] * 10, T0, 5, 15)
    assert empty["peak_cm"] is None and empty["minutes_flooded"] is None


def test_parse_since():
    assert parse_since("24h") == 86400 and parse_since("90m") == 5400 and parse_since("bogus") == 86400


# ---------------- demo ----------------
def test_demo_extrapolation_and_clamp():
    assert current_demo_s("playing", 10, T0, 2, T0 + timedelta(seconds=5), 124) == 20
    assert current_demo_s("paused", 10, T0, 2, T0 + timedelta(seconds=5), 124) == 10
    assert current_demo_s("playing", 120, T0, 4, T0 + timedelta(seconds=5), 124) == 124


def test_demo_interpolation():
    tl = [(0, 3.0), (10, 5.0), (20, 25.0)]
    assert interpolate(tl, -1) == 3.0 and interpolate(tl, 5) == 4.0 and interpolate(tl, 15) == 15.0 and interpolate(tl, 99) == 25.0


# ---------------- profile replay ----------------
def test_csv_mapping_is_continuous_ping_pong():
    s, e = T0 - timedelta(hours=24), T0
    anchor = T0 + timedelta(days=100)
    assert csv_time_for(anchor - timedelta(hours=1), anchor, s, e) == e - timedelta(hours=1)   # history: forward
    assert csv_time_for(anchor, anchor, s, e) == e
    assert csv_time_for(anchor + timedelta(minutes=10), anchor, s, e) == e - timedelta(minutes=10)  # then reverse
    assert csv_time_for(anchor + timedelta(hours=24), anchor, s, e) == s
    assert csv_time_for(anchor + timedelta(hours=25), anchor, s, e) == s + timedelta(hours=1)  # then forward again


def test_profile_value_interpolates_and_respects_gaps():
    series = {0: 2.0, 1: 4.0, 3: 10.0}
    assert profile_value(series, T0 + timedelta(seconds=30), T0) == 3.0
    assert profile_value(series, T0 + timedelta(minutes=1), T0) == 4.0
    assert profile_value(series, T0 + timedelta(seconds=150), T0) is None   # minute 2 missing


# ---------------- route selection (synthetic grid, same shape as test_routing) ----------------
LAT0, LON0, STEP = 33.50, -112.00, 0.002
POS = {0: (0, 0), 1: (1, 0), 2: (2, 0), 3: (0, -1), 4: (1, -1), 5: (2, -1)}


def lnglat(n):
    x, y = POS[n]
    return (LON0 + x * STEP, LAT0 + y * STEP)


@pytest.fixture
def net():
    G = nx.MultiDiGraph(crs="epsg:4326")
    for n, (x, y) in POS.items():
        G.add_node(n, x=LON0 + x * STEP, y=LAT0 + y * STEP)

    def road(u, v, tt, name):
        G.add_edge(u, v, travel_time=tt, length=tt * 10, name=name)
        G.add_edge(v, u, travel_time=tt, length=tt * 10, name=name)
    road(0, 1, 10, "Top St"); road(1, 2, 10, "Top St")
    road(0, 3, 15, "West Ave"); road(3, 4, 15, "Low St"); road(4, 5, 15, "Low St"); road(5, 2, 15, "East Ave")
    n = RoadNetwork(G)
    a, b = lnglat(0), lnglat(1)
    n.map_sensors([("s_ab", (a[1] + b[1]) / 2 + 0.0001, (a[0] + b[0]) / 2)])
    return n


def S(status, depth=1.0):
    return {"s_ab": {"name": "Top dip", "status": status, "depth_cm": depth}}


def test_dry_route_is_fastest_and_safe(net):
    d = build_routes(net, lnglat(0), lnglat(2), S("clear"))
    assert d["recommended"] == "r_fast" and len(d["routes"]) == 1
    r = d["routes"][0]
    assert r["safe"] and r["crosses"][0]["sensor_id"] == "s_ab" and r["crosses"][0]["at_distance_m"] == 0
    assert r["steps"][0]["instruction"].startswith("Head east on Top St")


def test_flooded_gives_safer_route(net):
    d = build_routes(net, lnglat(0), lnglat(2), S("flooded", 40))
    fast, safer = d["routes"]
    assert d["recommended"] == "r_safer"
    assert not fast["safe"] and fast["crosses"][0]["status"] == "flooded"
    assert safer["safe"] and safer["crosses"] == [] and safer["delta_vs_fastest_s"] == 60 - 20
    assert [s["road"] for s in safer["steps"]] == ["West Ave", "Low St", "East Ave"]


def test_offline_avoided_only_when_asked(net):
    assert build_routes(net, lnglat(0), lnglat(2), S("offline"))["recommended"] == "r_safer"
    assert build_routes(net, lnglat(0), lnglat(2), S("offline"), avoid_offline=False)["recommended"] == "r_fast"


def test_hazard_blocks_route(net):
    d = build_routes(net, lnglat(0), lnglat(2), S("clear"), hazard_edges={(1, 2), (2, 1)})
    assert d["recommended"] == "r_safer" and not d["routes"][0]["safe"]


def test_no_safe_path_returns_fastest_flagged(net):
    net.sensor_edges["s_west"] = {(0, 3), (3, 0)}
    sensors = {**S("flooded"), "s_west": {"name": "W", "status": "flooded", "depth_cm": 30}}
    d = build_routes(net, lnglat(0), lnglat(2), sensors)
    assert d["recommended"] == "r_fast" and len(d["routes"]) == 1 and not d["routes"][0]["safe"]
