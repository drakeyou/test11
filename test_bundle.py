#!/usr/bin/env python3
"""End-to-end: collect a fixture, export it, read the bundle back.

    python3 test_bundle.py

The unit tests check that write_csv refuses a mismatched header. This checks the
thing that actually went wrong three times running: that the columns the
collector computes reach the CSV a person opens. It writes a store through the
collector's own Store class, runs export.py over it, and reads the header.
"""

import csv
import os
import subprocess
import sys
import tempfile


def check(name, condition):
    assert condition, name


ROOT = os.path.dirname(os.path.abspath(__file__))

# Columns that exist because an analysis asked for them and got nothing. Each
# one was computed, stored, and then dropped by the exporter's header.
REQUIRED = [
    "paired_asset_id", "paired_bid", "paired_ask", "paired_ask_size",
    "fair_lower_bound", "fair_upper_bound", "fair_mid", "book_sum",
    "internal_dislocation", "paired_stale_seconds",
    "levels_touched", "size_eaten_partial", "n_bid_levels_before", "book_frozen",
]

with tempfile.TemporaryDirectory() as tmp:
    data = os.path.join(tmp, "data")
    out = os.path.join(tmp, "export")

    made = subprocess.run([("node"), os.path.join(ROOT, "fixture.mjs"), data],
                          cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True)
    check(f"the fixture builds: {made.stderr}", made.returncode == 0)

    ran = subprocess.run([sys.executable, "export.py", "--db", data, "--out", out],
                         cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True)
    check(f"the export runs: {ran.stderr or ran.stdout}", ran.returncode == 0)

    with open(os.path.join(out, "sweeps.csv"), newline="", encoding="utf-8") as handle:
        sweeps = list(csv.DictReader(handle))
    check("the significance filter still drops the small collapse", len(sweeps) == 1)
    row = sweeps[0]

    missing = [c for c in REQUIRED if c not in row]
    check(f"sweeps.csv carries the paired columns, missing {missing}", not missing)
    empty = [c for c in REQUIRED if row[c] == ""]
    check(f"and they are filled, empty {empty}", not empty)

    # The values are the collector's, not recomputed on the way out.
    check("fair_lower_bound is the stored bound", row["fair_lower_bound"] == "0.15")
    check("paired_ask_size says how much backs it", float(row["paired_ask_size"]) == 320)
    # book_frozen comes from the longest horizon: the fixture's book moved by 15
    # minutes even though it had not moved after one.
    check("book_frozen is the fifteen-minute answer", row["book_frozen"] == "0")
    check("levels_touched sees the thinned levels levels_crossed misses",
          int(row["levels_touched"]) > int(row["levels_crossed"]))

    readme = open(os.path.join(out, "README.md"), encoding="utf-8").read()
    check("the README describes every column it wrote",
          "undescribed" not in readme)
    for column in REQUIRED:
        check(f"the README explains {column}", f"`{column}`" in readme)
    check("and no longer calls the dead gg.bet ratio the central metric",
          "The central metric" not in readme)
    check("the README lists the files that are actually here",
          "`universe-summary.csv`" in readme and "`universe.csv`" not in readme)
    check("and describes the series it just wrote", "`book-series.csv`" in readme)

    # The time series: the same quantities as sweeps.csv, thinned to one
    # snapshot every thirty seconds around the collapse.
    with open(os.path.join(out, "book-series.csv"), newline="", encoding="utf-8") as handle:
        series = list(csv.DictReader(handle))
    check("the series is centred on the sweep",
          series[0]["sweep_id"] == "tok-a:2026-09-03T12:00:00.000Z")
    check("it starts before the collapse", float(series[0]["seconds_from_sweep"]) < 0)
    check("and runs past it", float(series[-1]["seconds_from_sweep"]) > 0)
    check("the twin is on every row", all(r["paired_ask"] for r in series))
    check("the floor is derived, not stored",
          abs(float(series[0]["fair_lower_bound"]) - (1 - float(series[0]["paired_ask"]))) < 1e-9)
    # Two fixture snapshots fall in the same half-minute bucket; one survives.
    stamps = [round(float(r["seconds_from_sweep"]) // 30) for r in series]
    check("thinning keeps one sample per bucket", len(stamps) == len(set(stamps)))

    with open(os.path.join(out, "fill-context.csv"), newline="", encoding="utf-8") as handle:
        fills = list(csv.DictReader(handle))
    check("the fill context survives the round trip", len(fills) == 1)
    check("with the floor under the fill",
          fills[0]["fair_lower_bound_before"] == "0.15")

print("all bundle tests passed")
