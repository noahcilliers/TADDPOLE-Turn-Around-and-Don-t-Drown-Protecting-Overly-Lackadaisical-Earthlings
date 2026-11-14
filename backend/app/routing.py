"""Local road-network routing that can close specific segments.

Loads the OSMnx graph once; each sensor is snapped to its nearest road segment
(both directions). Flooded sensors' segments are hidden from Dijkstra.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import networkx as nx
import numpy as np

Edge = tuple[int, int]  # (u, v); parallel edges between u,v are treated as one segment


@dataclass
class Route:
    path: list[int]
    edges: set[Edge]
    coords: list[list[float]]           # GeoJSON order: [lon, lat]
    distance_m: float
    duration_s: float
    sensors_on_route: list[str] = field(default_factory=list)
    avoided_sensors: list[str] = field(default_factory=list)
    legs: list[tuple[int, int, dict]] = field(default_factory=list)   # chosen edge per hop

    def to_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": self.coords},
            "properties": {
                "distance_m": round(self.distance_m, 1),
                "duration_s": round(self.duration_s, 1),
                "sensors_on_route": self.sensors_on_route,
                "avoided_sensors": self.avoided_sensors,
            },
        }


class NoRoute(Exception):
    pass


def _meters_xy(lat0: float):
    """Equirectangular projection around lat0 -> metres. Fine for a neighbourhood."""
    kx = 111_320.0 * math.cos(math.radians(lat0))
    ky = 110_540.0
    return lambda lon, lat: (lon * kx, lat * ky)


def _point_seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


class RoadNetwork:
    def __init__(self, G: nx.MultiDiGraph):
        self.G = G
        self._node_ids = np.array(list(G.nodes))
        lats = np.array([G.nodes[n]["y"] for n in self._node_ids], dtype=float)
        lons = np.array([G.nodes[n]["x"] for n in self._node_ids], dtype=float)
        self._lat0 = float(lats.mean()) if len(lats) else 0.0
        self._proj = _meters_xy(self._lat0)
        self._nx, self._ny = self._proj(lons, lats)
        self.bounds = (float(lons.min()), float(lats.min()), float(lons.max()), float(lats.max()))
        self.sensor_edges: dict[str, set[Edge]] = {}
        self.sensor_segment: dict[str, Edge] = {}   # the single snapped edge (for drawing)

    # ---------- loading ----------
    @classmethod
    def from_graphml(cls, path: str | Path) -> "RoadNetwork":
        import osmnx as ox  # heavy import; only needed for loading

        return cls(ox.load_graphml(path))

    # ---------- snapping ----------
    def nearest_node(self, lat: float, lon: float) -> int:
        px, py = self._proj(lon, lat)
        i = int(np.argmin((self._nx - px) ** 2 + (self._ny - py) ** 2))
        return int(self._node_ids[i])

    def _edge_points(self, u: int, v: int, data: dict) -> list[tuple[float, float]]:
        geom = data.get("geometry")
        if geom is not None:
            return [(x, y) for x, y in geom.coords]  # (lon, lat)
        return [(self.G.nodes[u]["x"], self.G.nodes[u]["y"]), (self.G.nodes[v]["x"], self.G.nodes[v]["y"])]

    def nearest_segment(self, lat: float, lon: float) -> tuple[set[Edge], float]:
        """Nearest road segment to a point, returned in both directions, plus distance (m)."""
        px, py = self._proj(lon, lat)
        best, best_d = None, math.inf
        for u, v, data in self.G.edges(data=True):
            pts = [self._proj(x, y) for x, y in self._edge_points(u, v, data)]
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                d = _point_seg_dist(px, py, ax, ay, bx, by)
                if d < best_d:
                    best, best_d = (u, v), d
        if best is None:
            return set(), math.inf
        u, v = best
        edges = {(u, v)}
        if self.G.has_edge(v, u):  # two-way road = two directed edges in OSM
            edges.add((v, u))
        return edges, best_d

    def map_sensors(self, sensors: list[tuple[str, float, float]]) -> dict[str, float]:
        """sensors: [(sensor_id, lat, lon)]. Returns snap distance (m) per sensor."""
        dists: dict[str, float] = {}
        mapping: dict[str, set[Edge]] = {}
        seg: dict[str, Edge] = {}
        for sid, lat, lon in sensors:
            edges, d = self.nearest_segment(lat, lon)
            mapping[sid] = edges
            dists[sid] = d
            if edges:
                seg[sid] = min(edges)  # deterministic; both directions share geometry
        self.sensor_edges = mapping
        self.sensor_segment = seg
        return dists

    def segment_coords(self, sid: str) -> list[list[float]] | None:
        e = self.sensor_segment.get(sid)
        if e is None:
            return None
        u, v = e
        return [[float(x), float(y)] for x, y in self._edge_points(u, v, self._best_edge(u, v))]

    def legs_for_steps(self, r: "Route"):
        """(name, length, bearing_start, bearing_end) per hop, for turn-by-turn steps."""
        from .steps import Leg, bearing, road_name

        out = []
        for u, v, d in r.legs:
            pts = self._oriented_points(u, v, d)
            b0 = bearing(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
            b1 = bearing(pts[-2][0], pts[-2][1], pts[-1][0], pts[-1][1])
            out.append(Leg(road_name(d.get("name")), float(d.get("length", 0.0)), b0, b1))
        return out

    def at_distance(self, r: "Route", edges: set[Edge]) -> float | None:
        """Metres along the route to the start of the first hop in `edges`."""
        acc = 0.0
        for u, v, d in r.legs:
            if (u, v) in edges:
                return acc
            acc += float(d.get("length", 0.0))
        return None

    def contains(self, lat: float, lon: float, margin_deg: float = 0.005) -> bool:
        w, s, e, n = self.bounds
        return (w - margin_deg) <= lon <= (e + margin_deg) and (s - margin_deg) <= lat <= (n + margin_deg)

    # ---------- routing ----------
    def blocked_edges(self, flooded_sensor_ids) -> set[Edge]:
        out: set[Edge] = set()
        for sid in flooded_sensor_ids:
            out |= self.sensor_edges.get(sid, set())
        return out

    def sensors_on(self, edges: set[Edge], only: set[str] | None = None) -> list[str]:
        return sorted(
            sid for sid, se in self.sensor_edges.items()
            if (only is None or sid in only) and se & edges
        )

    def _best_edge(self, u: int, v: int) -> dict:
        return min(self.G[u][v].values(), key=self._cost)

    @staticmethod
    def _cost(d: dict) -> float:
        tt = d.get("travel_time")
        if tt is not None:
            return float(tt)
        return float(d.get("length", 1.0)) / 11.0  # ~40 km/h fallback

    def route(
        self,
        orig: tuple[float, float],
        dest: tuple[float, float],
        flooded_sensor_ids: set[str] | frozenset[str] = frozenset(),
        extra_blocked: set[Edge] | frozenset[Edge] = frozenset(),
    ) -> Route:
        """orig/dest are (lat, lon). Raises NoRoute if flooding cuts every path."""
        o = self.nearest_node(*orig)
        t = self.nearest_node(*dest)
        blocked = self.blocked_edges(flooded_sensor_ids) | set(extra_blocked)

        def w(u, v, d):  # returning None hides the edge from Dijkstra
            return None if (u, v) in blocked else min(self._cost(e) for e in d.values())

        try:
            path = nx.shortest_path(self.G, o, t, weight=w)
        except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
            raise NoRoute(str(exc)) from exc

        r = self._build(path)
        r.sensors_on_route = self.sensors_on(r.edges)
        if blocked:
            try:
                naive = nx.shortest_path(self.G, o, t, weight=lambda u, v, d: min(self._cost(e) for e in d.values()))
                r.avoided_sensors = self.sensors_on(self._edges_of(naive), only=set(flooded_sensor_ids))
            except nx.NetworkXNoPath:
                pass
        return r

    @staticmethod
    def _edges_of(path: list[int]) -> set[Edge]:
        return set(zip(path, path[1:]))

    def _build(self, path: list[int]) -> Route:
        coords: list[list[float]] = []
        dist = dur = 0.0
        if len(path) == 1:
            n = self.G.nodes[path[0]]
            coords = [[n["x"], n["y"]]]
        legs = []
        for u, v in zip(path, path[1:]):
            d = self._best_edge(u, v)
            pts = self._oriented_points(u, v, d)
            seg = [[float(x), float(y)] for x, y in pts]
            coords.extend(seg if not coords else seg[1:])
            dist += float(d.get("length", 0.0))
            dur += self._cost(d)
            legs.append((u, v, d))
        return Route(path=path, edges=self._edges_of(path), coords=coords, distance_m=dist, duration_s=dur, legs=legs)

    def _oriented_points(self, u: int, v: int, d: dict) -> list[tuple[float, float]]:
        """Edge geometry running u -> v (OSMnx stores it that way; guard anyway)."""
        pts = self._edge_points(u, v, d)
        ux, uy = self.G.nodes[u]["x"], self.G.nodes[u]["y"]
        if (pts[0][0] - ux) ** 2 + (pts[0][1] - uy) ** 2 > (pts[-1][0] - ux) ** 2 + (pts[-1][1] - uy) ** 2:
            pts = pts[::-1]
        return pts
