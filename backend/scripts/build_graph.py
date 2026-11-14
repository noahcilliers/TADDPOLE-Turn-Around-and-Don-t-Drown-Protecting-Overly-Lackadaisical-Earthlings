"""One-time: download the drivable road network for the demo area and save it.

Run before the hackathon (needs internet); the backend loads the file at startup
so routing works offline.

    python scripts/build_graph.py                      # default Arcadia / Camelback East bbox
    python scripts/build_graph.py --bbox -112.02 33.48 -111.95 33.53 --out data/camelback.graphml
"""
import argparse

import osmnx as ox


def main() -> None:
    p = argparse.ArgumentParser()
    # osmnx 2.x bbox order: (west, south, east, north)
    p.add_argument("--bbox", nargs=4, type=float, default=[-112.03, 33.455, -111.95, 33.53],
                   metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    p.add_argument("--out", default="data/camelback.graphml")
    p.add_argument("--overpass-url", default=None,
                   help="Overpass mirror, e.g. https://overpass.private.coffee/api "
                        "(the main overpass-api.de endpoint may refuse scripted use)")
    a = p.parse_args()
    # overpass-api.de rejects the library's default User-Agent as "automated"; identify ourselves.
    ox.settings.http_user_agent = "floodroute-hackathon/0.1 (one-time neighbourhood extract)"
    if a.overpass_url:
        ox.settings.overpass_url = a.overpass_url

    G = ox.graph_from_bbox(bbox=tuple(a.bbox), network_type="drive")
    G = ox.add_edge_travel_times(ox.add_edge_speeds(G))
    ox.save_graphml(G, a.out)
    print(f"saved {a.out}: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")


if __name__ == "__main__":
    main()
