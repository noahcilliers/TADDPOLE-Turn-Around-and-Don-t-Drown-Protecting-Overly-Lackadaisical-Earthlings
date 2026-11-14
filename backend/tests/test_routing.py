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
