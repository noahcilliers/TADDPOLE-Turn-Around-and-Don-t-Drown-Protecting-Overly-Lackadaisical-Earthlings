"""Routing on a tiny synthetic grid (no network / OSM download needed).

    a(0) --- b(1) --- c(2)
    |                 |
    d(3) --- e(4) --- f(5)

Top row is fast; bottom row is the detour. A sensor sits on a-b.
"""
import networkx as nx
import pytest

from app.routing import NoRoute, RoadNetwork

LAT0, LON0, STEP = 33.50, -112.00, 0.002
POS = {0: (0, 0), 1: (1, 0), 2: (2, 0), 3: (0, -1), 4: (1, -1), 5: (2, -1)}


def ll(n):
    x, y = POS[n]
    return (LAT0 + y * STEP, LON0 + x * STEP)


@pytest.fixture
def net():
    G = nx.MultiDiGraph(crs="epsg:4326")
    for n, (x, y) in POS.items():
        G.add_node(n, x=LON0 + x * STEP, y=LAT0 + y * STEP)
    def road(u, v, tt):
        G.add_edge(u, v, travel_time=tt, length=tt * 10)
        G.add_edge(v, u, travel_time=tt, length=tt * 10)
    road(0, 1, 10); road(1, 2, 10)                    # fast top row
    road(0, 3, 15); road(3, 4, 15); road(4, 5, 15); road(5, 2, 15)
    n = RoadNetwork(G)
    mid_ab = ((ll(0)[0] + ll(1)[0]) / 2 + 0.0001, (ll(0)[1] + ll(1)[1]) / 2)
    n.map_sensors([("s_ab", *mid_ab)])
    return n


def test_sensor_snaps_both_directions(net):
    assert net.sensor_edges["s_ab"] == {(0, 1), (1, 0)}


def test_route_uses_fast_road_when_dry(net):
    r = net.route(ll(0), ll(2))
    assert r.path == [0, 1, 2]
    assert r.sensors_on_route == ["s_ab"]
    assert r.avoided_sensors == []
    geo = r.to_geojson()
    assert geo["geometry"]["type"] == "LineString"
    assert geo["geometry"]["coordinates"][0] == [ll(0)[1], ll(0)[0]]  # [lon, lat]


def test_flooded_sensor_forces_detour_both_ways(net):
    r = net.route(ll(0), ll(2), {"s_ab"})
    assert r.path == [0, 3, 4, 5, 2]
    assert r.avoided_sensors == ["s_ab"]
    back = net.route(ll(2), ll(0), {"s_ab"})
    assert (1, 0) not in back.edges


def test_no_route_when_cut_off(net):
    net.sensor_edges["s_ad"] = {(0, 3), (3, 0)}
    with pytest.raises(NoRoute):
        net.route(ll(0), ll(2), {"s_ab", "s_ad"})


def test_block_radius_closes_neighbouring_segments(net):
    # sensor sits on a-b; with a radius covering the whole top-left corner, a-d gets closed too
    mid_ab = ((ll(0)[0] + ll(1)[0]) / 2, (ll(0)[1] + ll(1)[1]) / 2)
    net.map_sensors([("s_ab", *mid_ab)], block_radius_m=150)
    assert {(0, 1), (1, 0), (0, 3), (3, 0)} <= net.sensor_edges["s_ab"]
    assert net.sensor_segment["s_ab"] in {(0, 1), (1, 0)}  # drawn segment stays the snapped edge


def _grid3():
    """3x3 grid, all streets equal. Top-left a(0) to bottom-right i(8):
         0 - 1 - 2
         |   |   |
         3 - 4 - 5
         |   |   |
         6 - 7 - 8
    """
    G = nx.MultiDiGraph(crs="epsg:4326")
    pos = {i: (i % 3, -(i // 3)) for i in range(9)}
    for n, (x, y) in pos.items():
        G.add_node(n, x=LON0 + x * STEP, y=LAT0 + y * STEP)
    def road(u, v):
        G.add_edge(u, v, travel_time=10, length=200); G.add_edge(v, u, travel_time=10, length=200)
    for a, b in [(0, 1), (1, 2), (3, 4), (4, 5), (6, 7), (7, 8), (0, 3), (3, 6), (1, 4), (4, 7), (2, 5), (5, 8)]:
        road(a, b)
    def node_ll(n):
        x, y = pos[n]
        return (LAT0 + y * STEP, LON0 + x * STEP)
    return RoadNetwork(G), node_ll


def test_clear_sensor_bonus_breaks_ties():
    net, nl = _grid3()
    # a clear sensor on the 0-1 stretch; the 0->3->6->7->8 and 0->1->2->5->8 detours are otherwise equal
    a, b = nl(0), nl(1)
    net.map_sensors([("s_clear", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)], near_radius_m=50)
    mult = net.status_multipliers({"s_clear": "clear"}, unsafe=set())
    r = net.route(nl(0), nl(8), multipliers=mult)
    assert (0, 1) in r.edges


def test_flood_buffer_pushes_route_away():
    net, nl = _grid3()
    # flooded sensor on the middle node 4's west stretch; only its own edges are closed (radius 0),
    # but the buffer makes everything near it expensive, so the route takes the outer ring
    a, b = nl(3), nl(4)
    net.map_sensors([("s_flood", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)], near_radius_m=1000)
    net.prefs.flood_buffer_m = 200  # grid blocks are ~200 m; the outer ring sits just outside the buffer
    mult = net.status_multipliers({"s_flood": "flooded"}, unsafe={"s_flood"})
    r = net.route(nl(1), nl(7), frozenset({"s_flood"}), multipliers=mult)
    assert 4 not in r.path  # went around the outside instead of straight down the middle


def test_caution_costs_more_than_clear():
    net, nl = _grid3()
    a, b = nl(0), nl(1)
    net.map_sensors([("s", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)], near_radius_m=300)
    up = net.status_multipliers({"s": "caution"}, unsafe=set())
    down = net.status_multipliers({"s": "clear"}, unsafe=set())
    assert up[(0, 1)] > 1 > down[(0, 1)]
