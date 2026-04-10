#!/usr/bin/env python3
"""Build a persistent boundary bundle for the POTA map app.

Usage examples:
  python scripts/build_boundary_bundle.py --states UT
  python scripts/build_boundary_bundle.py --states UT CO AZ --delay-ms 300
  python scripts/build_boundary_bundle.py --all
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

try:
    import osm2geojson  # type: ignore
except Exception:
    print("Missing dependency: osm2geojson", file=sys.stderr)
    print("Install with: python -m pip install requests osm2geojson", file=sys.stderr)
    raise


ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
NO_BOUNDARY_CACHE_VERSION = 2


@dataclass
class Park:
    reference: str
    name: str
    location: str
    lat: float
    lon: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build data/us-boundaries.json from Overpass")
    parser.add_argument("--parks-file", default="data/us-parks.json")
    parser.add_argument("--output", default="data/us-boundaries.json")
    parser.add_argument("--states", nargs="*", default=[])
    parser.add_argument("--all", action="store_true", help="Process all parks in parks file")
    parser.add_argument("--delay-ms", type=int, default=250)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max", type=int, default=0, help="Limit number of parks (0 = no limit)")
    parser.add_argument(
        "--issues-log",
        default="data/us-boundary-issues.jsonl",
        help="Path to write boundary issue records (JSONL)",
    )
    return parser.parse_args()


def load_parks(path: Path) -> list[Park]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    parks: list[Park] = []
    for row in data:
        parks.append(
            Park(
                reference=row["reference"],
                name=row["name"],
                location=row["location"],
                lat=float(row["lat"]),
                lon=float(row["lon"]),
            )
        )
    return parks


def park_has_state(park: Park, state: str) -> bool:
    target = f"US-{state}"
    return target in [x.strip().upper() for x in str(park.location).split(",")]


def normalize_for_name_match(value: str) -> str:
    text = value.lower().replace("&", " and ")
    replacements = [
        r"\bnational wildlife refuge\b",
        r"\bnational wild and scenic river\b",
        r"\bwild and scenic river\b",
        r"\bnational historical park\b",
        r"\bnational historic trail\b",
        r"\bnational recreation area\b",
        r"\bnational monument\b",
        r"\bnational park\b",
        r"\bnational forest\b",
        r"\bstate park\b",
    ]
    for pat in replacements:
        text = re.sub(pat, " ", text)
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def name_similarity_score(a: str, b: str) -> float:
    ta = set(normalize_for_name_match(a).split())
    tb = set(normalize_for_name_match(b).split())
    if not ta or not tb:
        return 0.0
    intersection = len(ta.intersection(tb))
    return intersection / min(len(ta), len(tb))


def build_exact_query(park: Park, radius: int) -> str:
    name = park.name.replace('"', '\\"')
    return f"""
[out:json][timeout:60];
(
  relation(around:{radius},{park.lat},{park.lon})["name"="{name}"]["boundary"~"protected_area|national_park"];
  relation(around:{radius},{park.lat},{park.lon})["name"="{name}"]["leisure"="nature_reserve"];
  relation(around:{radius},{park.lat},{park.lon})["name"="{name}"]["type"="boundary"];
  way(around:{radius},{park.lat},{park.lon})["name"="{name}"]["boundary"~"protected_area|national_park"];
  way(around:{radius},{park.lat},{park.lon})["name"="{name}"]["leisure"="nature_reserve"];
);
out body;
>;
out skel qt;
""".strip()


def build_broad_query(park: Park, radius: int) -> str:
    return f"""
[out:json][timeout:60];
(
  relation(around:{radius},{park.lat},{park.lon})["boundary"~"protected_area|national_park"];
  relation(around:{radius},{park.lat},{park.lon})["leisure"="nature_reserve"];
  way(around:{radius},{park.lat},{park.lon})["boundary"~"protected_area|national_park"];
  way(around:{radius},{park.lat},{park.lon})["leisure"="nature_reserve"];
);
out body;
>;
out skel qt;
""".strip()


def overpass_request(query: str, retries: int, timeout: int) -> dict[str, Any]:
    last_error: Exception | None = None
    for endpoint in ENDPOINTS:
        for attempt in range(retries + 1):
            try:
                response = requests.post(
                    endpoint,
                    data={"data": query},
                    timeout=timeout,
                    headers={"User-Agent": "pota-map-bundle-builder/1.0"},
                )
                if response.status_code == 429:
                    time.sleep(3 + attempt * 2)
                    continue
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                time.sleep(1.5 + attempt)
    if last_error is None:
        raise RuntimeError("Overpass request failed with unknown error")
    raise last_error


def to_geojson(overpass_json: dict[str, Any]) -> dict[str, Any]:
    return osm2geojson.json2geojson(overpass_json)


def extract_polygon_features(geojson: dict[str, Any]) -> list[dict[str, Any]]:
    features = geojson.get("features", [])
    return [
        f
        for f in features
        if f.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}
    ]


def ring_centroid(coords: Iterable[list[float]]) -> tuple[float, float] | None:
    lat_total = 0.0
    lon_total = 0.0
    count = 0
    for point in coords:
        lon_total += float(point[0])
        lat_total += float(point[1])
        count += 1
    if count == 0:
        return None
    return (lat_total / count, lon_total / count)


def feature_center(feature: dict[str, Any]) -> tuple[float, float] | None:
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "Polygon" and coords and coords[0]:
        return ring_centroid(coords[0])
    if gtype == "MultiPolygon" and coords and coords[0] and coords[0][0]:
        return ring_centroid(coords[0][0])
    return None


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    to_rad = math.pi / 180.0
    dlat = (lat2 - lat1) * to_rad
    dlon = (lon2 - lon1) * to_rad
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(dlon / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def annotate_and_rank_features(park: Park, features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for feature in features:
        fid = str(feature.get("id") or f"obj-{len(unique)+1}")
        if fid not in unique:
            unique[fid] = feature

    scored: list[tuple[float, dict[str, Any]]] = []
    for feature in unique.values():
        center = feature_center(feature)
        distance = (
            distance_km(park.lat, park.lon, center[0], center[1])
            if center
            else float("inf")
        )
        props = feature.get("properties") or {}
        boundary = str(props.get("boundary") or "")
        tag_bonus = -50 if boundary in {"protected_area", "national_park"} else 0
        rel_bonus = -25 if str(feature.get("id", "")).startswith("relation/") else 0
        similarity = float(props.get("_potaSimilarity") or 0.0)
        sim_bonus = -100 * similarity if similarity > 0 else 0
        score = distance + tag_bonus + rel_bonus + sim_bonus
        scored.append((score, feature))
    scored.sort(key=lambda x: x[0])
    return [x[1] for x in scored[:12]]


def fetch_boundary_geojson(park: Park, retries: int, timeout: int) -> dict[str, Any] | None:
    radius = 350000 if "National Forest" in park.name else 120000
    first = overpass_request(build_exact_query(park, radius), retries=retries, timeout=timeout)
    geo = to_geojson(first)
    features = extract_polygon_features(geo)

    if not features:
        second = overpass_request(build_exact_query(park, 450000), retries=retries, timeout=timeout)
        geo = to_geojson(second)
        features = extract_polygon_features(geo)

    if not features:
        broad = overpass_request(build_broad_query(park, 180000), retries=retries, timeout=timeout)
        geo = to_geojson(broad)
        candidates: list[dict[str, Any]] = []
        for feature in extract_polygon_features(geo):
            candidate_name = str((feature.get("properties") or {}).get("name") or "")
            similarity = name_similarity_score(park.name, candidate_name)
            if similarity >= 0.45:
                props = dict(feature.get("properties") or {})
                props["_potaMatchNote"] = (
                    f"{park.reference} {park.name}... found match {candidate_name}"
                )
                props["_potaSimilarity"] = similarity
                feature["properties"] = props
                candidates.append(feature)
        features = candidates

    if not features:
        return None

    final_features = annotate_and_rank_features(park, features)
    return {"type": "FeatureCollection", "features": final_features}


def load_existing_records(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        bundle = json.loads(path.read_text(encoding="utf-8-sig"))
        records = bundle.get("records", [])
        out: dict[str, dict[str, Any]] = {}
        for record in records:
            ref = record.get("reference")
            if isinstance(ref, str):
                out[ref] = record
        return out
    except Exception:  # noqa: BLE001
        return {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def now_ms() -> int:
    return int(time.time() * 1000)


def append_issue(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> int:
    args = parse_args()
    issues_path = Path(args.issues_log)
    issues_path.parent.mkdir(parents=True, exist_ok=True)
    issues_path.write_text("", encoding="utf-8")

    parks = load_parks(Path(args.parks_file))
    if not args.all:
        states = [s.strip().upper() for s in args.states if s.strip()]
        if not states:
            print("Provide --states XX [YY ...] or use --all", file=sys.stderr)
            return 2
        parks = [p for p in parks if any(park_has_state(p, s) for s in states)]

    if args.max > 0:
        parks = parks[: args.max]

    output_path = Path(args.output)
    existing = load_existing_records(output_path)

    fetched = 0
    no_boundary = 0
    failed = 0

    total = len(parks)
    print(f"Processing {total} park(s)...")
    print(f"Issues log: {issues_path}")

    for idx, park in enumerate(parks, start=1):
        if park.reference in existing:
            print(f"[{idx}/{total}] {park.reference} | {park.name} -> skip (already in bundle)")
            continue

        try:
            geojson = fetch_boundary_geojson(park, retries=args.retries, timeout=args.timeout)
            if geojson and geojson.get("features"):
                feature_count = len(geojson["features"])
                selected_name = str(
                    ((geojson["features"][0].get("properties") or {}).get("name"))
                    or park.name
                )
                match_note = str(
                    ((geojson["features"][0].get("properties") or {}).get("_potaMatchNote"))
                    or ""
                ).strip()
                existing[park.reference] = {
                    "reference": park.reference,
                    "geojson": geojson,
                    "noBoundaryVersion": None,
                    "updatedAt": now_ms(),
                }
                fetched += 1
                print(
                    f"[{idx}/{total}] {park.reference} | {park.name} -> "
                    f"boundary found '{selected_name}' ({feature_count} polygon"
                    f"{'' if feature_count == 1 else 's'} selected)"
                )
                if match_note:
                    append_issue(
                        issues_path,
                        {
                            "timestamp": now_iso(),
                            "reference": park.reference,
                            "name": park.name,
                            "location": park.location,
                            "status": "similar-name-fallback",
                            "detail": match_note,
                        },
                    )
            else:
                existing[park.reference] = {
                    "reference": park.reference,
                    "geojson": None,
                    "noBoundaryVersion": NO_BOUNDARY_CACHE_VERSION,
                    "updatedAt": now_ms(),
                }
                no_boundary += 1
                print(f"[{idx}/{total}] {park.reference} | {park.name} -> no boundary found")
                append_issue(
                    issues_path,
                    {
                        "timestamp": now_iso(),
                        "reference": park.reference,
                        "name": park.name,
                        "location": park.location,
                        "status": "no-boundary",
                        "detail": "No matching polygon boundary returned by Overpass/OSM",
                    },
                )
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"[{idx}/{total}] {park.reference} | {park.name} -> failed: {exc}", file=sys.stderr)
            append_issue(
                issues_path,
                {
                    "timestamp": now_iso(),
                    "reference": park.reference,
                    "name": park.name,
                    "location": park.location,
                    "status": "failed",
                    "detail": str(exc),
                },
            )

        time.sleep(max(args.delay_ms, 0) / 1000.0)

    ordered = [existing[k] for k in sorted(existing.keys())]
    bundle = {
        "version": 1,
        "generatedAt": now_iso(),
        "records": ordered,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        "Done. "
        f"new fetched={fetched}, new no-boundary={no_boundary}, failed={failed}, "
        f"total records in bundle={len(ordered)}"
    )
    print(f"Wrote: {output_path}")
    print(f"Wrote issues log: {issues_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
