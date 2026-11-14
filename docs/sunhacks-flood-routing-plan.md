# SunHacks Flood Routing: Map & Routing Plan

_2026-11-14 · Noah Cilliers_

## Summary

We need one small API, and only for the base map. The demo covers one neighborhood, so routing runs locally on our own machine instead of through a paid routing API. This also avoids the main limitation of hosted routing APIs: most can't be told "avoid this specific road segment because our sensor says it's flooded."

## Approach

1. **Base map:** Leaflet with OpenStreetMap tiles. Free, no API key, and matches the "about 50 lines" dashboard plan.
2. **Road network:** before the hackathon, use OSMnx to download the drivable roads in one small bounding box and save them to a file. Arcadia / Camelback East is the target area because it includes both 40th St & Camelback (Nov 1) and the Arizona Canal crossing (Oct 30). The backend loads the file at startup, so routing works even if venue Wi-Fi is bad.
3. **Rerouting:** each sensor is tied to its nearest road segment. When Tiger Data reports that sensor as flooded, the route search treats the segment as closed and finds the next-best path. The new route goes back to Leaflet as GeoJSON.

**Demo flow:** pour water on the sensor → pin turns red → route changes live. Nothing is faked.

## One-time setup

Bounding box coordinates are rough; adjust as needed.

```python
import osmnx as ox
# osmnx 2.x bbox order: (west, south, east, north)
G = ox.graph_from_bbox(bbox=(-112.02, 33.48, -111.95, 33.53), network_type="drive")
G = ox.add_edge_travel_times(ox.add_edge_speeds(G))
ox.save_graphml(G, "camelback.graphml")
```

## Backend routing

```python
import osmnx as ox, networkx as nx
G = ox.load_graphml("camelback.graphml")

# map each sensor to its road segment once
SENSOR_EDGES = {"sensor_40th_camelback": ox.nearest_edges(G, X=-111.996, Y=33.509)}

def route(orig_ll, dest_ll, flooded_sensor_ids):
    blocked = {SENSOR_EDGES[s] for s in flooded_sensor_ids}
    def w(u, v, d):  # returning None hides the edge
        return None if any((u, v, k) in blocked for k in d) else min(e["travel_time"] for e in d.values())
    o = ox.nearest_nodes(G, orig_ll[1], orig_ll[0])
    t = ox.nearest_nodes(G, dest_ll[1], dest_ll[0])
    path = nx.shortest_path(G, o, t, weight=w)
    return [[G.nodes[n]["y"], G.nodes[n]["x"]] for n in path]  # lat/lng for Leaflet
```

**To do:**

- Replace the placeholder sensor coordinates with real ones.
- Block the road in both directions. OSM usually stores a two-way road as two separate segments.

## Alternatives and notes

- **Hosted routing API:** GraphHopper's custom models can avoid specific areas, and its free tier covers a demo. It does add a key, rate limits and a network dependency in exchange for less code.
- **Lower-effort fallback:** the precomputed route swap from the product vision (two fixed routes, switch between them). Local routing is only about 30 extra lines and holds up better when judges ask "what if it floods somewhere else?"
- **Map tiles:** OSM's public tile server is fine for demo-level traffic. Bring a screenshot as backup in case the internet drops completely.
