#!/usr/bin/env node
/*
 * FloodRoute reference simulation (no dependencies).
 *
 * This is the exact logic behind the design prototypes: sensor profiles, status
 * thresholds, the stage-demo storm, the demo car, look-ahead alerts and the
 * analytics stats. Use it to:
 *   1. regenerate the sample data in ../data   ->  node sim.js generate ../data
 *   2. drive a server-side "demo mode" that injects synthetic readings
 *   3. cross-check your backend's status / stats / alert outputs in tests
 *
 * Units: depth in cm (inches are display-only). Distances: miles in the grid
 * model below, metres in the API. Time: the prototype's "now" (demo T = 0) is
 * DEMO_START. One demo second = 10 real seconds (DEMO_TIME_SCALE).
 */
'use strict';

const DEMO_START = '2026-08-14T18:40:00-07:00'; // a monsoon evening, Phoenix (MST, no DST)
const DEMO_TIME_SCALE = 10;

const THRESHOLDS = {
  caution_cm: 10, // >= caution
  flooded_cm: 30, // >= flooded (treat as impassable)
  offline_after_s: 300, // no reading for 5 min -> offline (unknown, never "clear")
  rising_fast_cm_per_min: 1.0, // optional: caution early if rising this fast and depth >= 5 cm
  hysteresis_cm: 2, // must fall this far below a threshold before downgrading
  lookahead_m: 1000, // warn about hazards within 1 km ahead
  lookahead_half_angle_deg: 20, // cone around heading
};

// --- grid model used by the designs -> real coordinates (approximate) -------
// x: miles east of 24th St, y: miles south of the line 1 mi north of Camelback Rd
const toLngLat = (x, y) => [+(-112.03 + x * 0.01734).toFixed(6), +(33.5239 - y * 0.01449).toFixed(6)];

const SENSORS = [
  { id: 'FR-07', key: 'S1', name: '40th St & Camelback', road: 'N 40th St dip, south of Camelback Rd', x: 2, y: 1, seg: [[2, 0.82], [2, 1.22]], battery_pct: 86, signal: 'strong', calibrated_at: '2026-06-12' },
  { id: 'FR-03', key: 'S2', name: '32nd St & Indian School', road: 'Indian School Rd low point at 32nd St', x: 1, y: 2, seg: [[0.8, 2], [1.2, 2]], battery_pct: 74, signal: 'good', calibrated_at: '2026-05-30' },
  { id: 'FR-11', key: 'S3', name: '44th St & Thomas', road: 'Thomas Rd dip east of 44th St', x: 2.5, y: 3, seg: [[2.3, 3], [2.7, 3]], battery_pct: 91, signal: 'strong', calibrated_at: '2026-06-12' },
  { id: 'FR-09', key: 'S4', name: '36th St & Thomas', road: 'Thomas Rd wash crossing at 36th St', x: 1.5, y: 3, seg: [[1.3, 3], [1.7, 3]], battery_pct: 68, signal: 'good', calibrated_at: '2026-05-30' },
  { id: 'FR-02', key: 'S5', name: '32nd St & Camelback', road: '32nd St dip north of Camelback Rd', x: 1, y: 1, seg: [[1, 0.8], [1, 1.2]], battery_pct: 9, signal: 'lost', calibrated_at: '2026-04-18' },
  { id: 'FR-12', key: 'S6', name: '44th St & Campbell', road: '44th St dip at Campbell Ave', x: 2.5, y: 1.5, seg: [[2.5, 1.32], [2.5, 1.68]], battery_pct: 80, signal: 'strong', calibrated_at: '2026-06-12' },
  { id: 'FR-14', key: 'S7', name: '40th St & McDowell', road: 'McDowell Rd low point at 40th St', x: 2, y: 4, seg: [[1.8, 4], [2.2, 4]], battery_pct: 77, signal: 'good', calibrated_at: '2026-06-02' },
];

// --- depth profiles: m = minutes relative to DEMO_START (negative = past) ----
const TC = 6 + (7 * 34) / 19; // demo second when FR-07 crosses 10 cm
const TF = 40 + 8 / 3.9; // demo second when FR-07 crosses 30 cm
const demoDepth = (t) => (t < 6 ? 3 : t < 40 ? 3 + ((t - 6) * 19) / 34 : t < 50 ? 22 + (t - 40) * 3.9 : Math.min(64, 61 + (t - 50) * 0.05));
const nz = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
const g = (x, c, w) => Math.exp(-((x - c) * (x - c)) / (2 * w * w));
const PROFILE = {
  S1: (m) => (m >= 0 ? demoDepth((m * 60) / DEMO_TIME_SCALE) : 2.2 + nz(Math.floor(m), 1) * 0.8 + 9 * g(m, -1420, 30) + 1 * g(m, -20, 15)),
  S2: (m) => 2 + nz(Math.floor(m), 2) * 0.6 + 16 * Math.min(1, Math.max(0, (m + 40) / 40)) + (m > 0 ? Math.min(4, m * 0.08) : 0) + 6 * g(m, -1400, 40),
  S3: (m) => 1.6 + nz(Math.floor(m), 3) * 0.6 + 12 * g(m, -50, 22) + 5 * g(m, -1430, 30),
  S4: (m) => 1 + nz(Math.floor(m), 4) * 0.5 + 3 * g(m, -1410, 30),
  S5: (m) => (m > -5 ? null : 1.5 + nz(Math.floor(m), 5) * 0.5 + 5 * g(m, -12, 15) + 4 * g(m, -1420, 30)), // goes offline 5 min before demo start
  S6: (m) => 2 + nz(Math.floor(m), 6) * 0.6 + 2 * g(m, -1415, 30),
  S7: (m) => 3 + nz(Math.floor(m), 7) * 0.7 + 19 * g(m, -1425, 35),
};

const statusOf = (d) => (d == null ? 'offline' : d >= THRESHOLDS.flooded_cm ? 'flooded' : d >= THRESHOLDS.caution_cm ? 'caution' : 'clear');
const iso = (m) => new Date(new Date(DEMO_START).getTime() + m * 60000).toISOString();

// --- analytics (same definitions as the Analytics panel) ---------------------
function stats(depthAt, nowMin, rangeH) {
  const Mt = rangeH * 60, N = 120, step = Mt / N;
  let peak = null, above = 0, flooded = 0, fastest = 0;
  for (let i = 0; i <= N; i++) {
    const m = nowMin - Mt + i * step, d = depthAt(m);
    if (d == null) continue;
    if (!peak || d > peak.d) peak = { m, d };
    if (d >= THRESHOLDS.caution_cm) above += step;
    if (d >= THRESHOLDS.flooded_cm) flooded += step;
    const d0 = depthAt(m - 5);
    if (d0 != null) fastest = Math.max(fastest, (d - d0) / 5);
  }
  return {
    range: rangeH + 'h',
    peak_cm: peak ? +peak.d.toFixed(1) : null,
    peak_at: peak ? iso(peak.m) : null,
    fastest_rise_cm_per_min: +fastest.toFixed(2), // max 5-minute rate in the window
    minutes_above_caution: Math.round(above),
    minutes_flooded: Math.round(flooded),
  };
}

// --- demo vehicle -----------------------------------------------------------
// mode "nav": route from (2,3.2) to (2,0.5); reroutes via Campbell Ave + 44th St once FR-07 floods.
// mode "watch": no destination, drives north from (2,2.0) and stops 0.25 mi short of the dip.
function demoCar(mode, T, opts = {}) {
  const nav = mode === 'nav';
  const v = nav ? 0.03 : 0.012; // miles per demo second
  const y0 = nav ? 3.2 : 2.0;
  const A = [[2, y0], [2, 0.5]];
  const B = [[2, y0], [2, 1.5], [2.5, 1.5], [2.5, 0.5], [2, 0.5]];
  const rerouteT = nav ? Math.min(TF, opts.stallAt != null ? opts.stallAt : Infinity) : Infinity;
  const path = nav && T >= rerouteT ? B : A;
  const L = (a, b) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  let len = 0; for (let i = 1; i < path.length; i++) len += L(path[i - 1], path[i]);
  const dmax = nav ? len : y0 - 1.25;
  let rem = Math.min(T * v, dmax), pos = path[0], heading = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], l = L(a, b);
    if (rem <= l || i === path.length - 1) { const f = l ? Math.min(1, rem / l) : 0; pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; heading = b[0] > a[0] ? 90 : b[0] < a[0] ? 270 : b[1] < a[1] ? 0 : 180; break; }
    rem -= l;
  }
  return { pos, heading, rerouted: nav && T >= rerouteT, path };
}

// hazard-ahead rule used by the prototypes (simplified to the 40th St corridor)
function alertLevel(mode, T, opts = {}) {
  const car = demoCar(mode, T, opts);
  const d = demoDepth(T), st = statusOf(d);
  const ahead = car.pos[1] > 1 && Math.abs(car.pos[0] - 2) < 1e-6 && !car.rerouted;
  const distMi = Math.max(0, car.pos[1] - 1);
  if (ahead && opts.stallAt != null && T >= opts.stallAt) return { level: 'stalled', distance_m: Math.round(distMi * 1609) };
  if (ahead && (st === 'caution' || st === 'flooded') && distMi * 1609 <= THRESHOLDS.lookahead_m) return { level: st, distance_m: Math.round(distMi * 1609) };
  return { level: null, distance_m: Math.round(distMi * 1609) };
}

// --- generator ----------------------------------------------------------------
function generate(outDir) {
  const fs = require('fs'), path = require('path');
  fs.mkdirSync(outDir, { recursive: true });
  const sensors = SENSORS.map((s) => {
    const d = PROFILE[s.key](0), prev = PROFILE[s.key](-5);
    let last = 0; if (d == null) { for (let k = 1; k < 300; k++) if (PROFILE[s.key](-k) != null) { last = -k; break; } }
    return {
      id: s.id, name: s.name, road: s.road,
      location: { type: 'Point', coordinates: toLngLat(s.x, s.y) },
      segment: { type: 'LineString', coordinates: s.seg.map((p) => toLngLat(p[0], p[1])) },
      battery_pct: s.battery_pct, signal: s.signal, calibrated_at: s.calibrated_at,
      current: {
        status: statusOf(d), depth_cm: d == null ? null : +d.toFixed(1),
        rate_cm_per_min: d == null || prev == null ? null : +((d - prev) / 5).toFixed(2),
        last_reading_at: iso(d == null ? last : 0),
      },
    };
  });
  fs.writeFileSync(path.join(outDir, 'sensors.json'), JSON.stringify({ as_of: DEMO_START, sensors }, null, 2));

  const rows = ['time,sensor_id,depth_cm'];
  const changes = [];
  SENSORS.forEach((s) => {
    let prev = statusOf(PROFILE[s.key](-1441));
    for (let m = -1440; m <= 0; m++) {
      const d = PROFILE[s.key](m);
      if (d != null) rows.push(`${iso(m)},${s.id},${d.toFixed(2)}`);
      const cur = statusOf(d);
      if (cur !== prev) changes.push({ time: iso(m), sensor_id: s.id, from: prev, to: cur, depth_cm: d == null ? null : +d.toFixed(1) });
      prev = cur;
    }
  });
  fs.writeFileSync(path.join(outDir, 'readings_24h.csv'), rows.join('\n') + '\n');
  changes.sort((a, b) => (a.time < b.time ? -1 : 1));
  fs.writeFileSync(path.join(outDir, 'status_changes_24h.json'), JSON.stringify(changes, null, 2));

  const st = {};
  SENSORS.forEach((s) => { st[s.id] = [1, 6, 24].map((h) => stats(PROFILE[s.key], 0, h)); });
  fs.writeFileSync(path.join(outDir, 'sensor_stats_at_demo_start.json'), JSON.stringify(st, null, 2));

  const timeline = [];
  for (let T = 0; T <= 124; T += 1) {
    const d = demoDepth(T);
    const nav = demoCar('nav', T), watch = demoCar('watch', T);
    timeline.push({
      demo_s: T, real_time: iso((T * DEMO_TIME_SCALE) / 60), sensor_id: 'FR-07', depth_cm: +d.toFixed(1), status: statusOf(d),
      nav_car: { lnglat: toLngLat(...nav.pos), heading: nav.heading, rerouted: nav.rerouted, alert: alertLevel('nav', T) },
      watch_car: { lnglat: toLngLat(...watch.pos), heading: watch.heading, alert: alertLevel('watch', T) },
    });
  }
  const scenario = {
    description: 'Stage demo: storm at 40th St & Camelback (FR-07). Readings for other sensors follow readings_24h.csv profiles.',
    demo_start: DEMO_START, demo_time_scale: DEMO_TIME_SCALE,
    key_moments_demo_s: { caution: +TC.toFixed(2), flooded: +TF.toFixed(2), nav_reroute: +TF.toFixed(2), watch_first_warning: +((2.0 - 1.62) / 0.012).toFixed(2), watch_car_stops: 62.5, nav_arrives: 123.3 },
    routes: {
      original: { coordinates: [[2, 3.2], [2, 0.5]].map((p) => toLngLat(...p)) },
      safer: { coordinates: [[2, 3.2], [2, 1.5], [2.5, 1.5], [2.5, 0.5], [2, 0.5]].map((p) => toLngLat(...p)), note: 'via Campbell Ave and 44th St, about +3 min' },
      destination: { name: 'N 40th St & E Stanford Dr', lnglat: toLngLat(2, 0.5) },
    },
    stalled_car_report: { lnglat: toLngLat(2, 1.17), sensor_id: 'FR-07', note: 'Presenter toggles it any time; drivers behind are warned immediately, even outside the 1 km look-ahead.' },
    timeline,
  };
  fs.writeFileSync(path.join(outDir, 'demo_scenario.json'), JSON.stringify(scenario, null, 2));
  console.log('wrote', outDir, rows.length - 1, 'readings,', changes.length, 'status changes');
}

module.exports = { DEMO_START, DEMO_TIME_SCALE, THRESHOLDS, SENSORS, PROFILE, demoDepth, statusOf, stats, demoCar, alertLevel, toLngLat };
if (require.main === module && process.argv[2] === 'generate') generate(process.argv[3] || '../data');
