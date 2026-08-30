#!/usr/bin/env python3
"""Build a small, self-describing bundle for analysis elsewhere.

    python3 export.py                 -> export/ plus export.zip
    python3 export.py --db data --out export

A day of collection is a couple of gigabytes, almost all of it the book table.
None of that belongs in a conversation. What does is every sweep with the
context that prices it, the labelled fills, and enough of the registry to say
what each market was. That comes to a fraction of a megabyte.
"""

import argparse
import csv
import os
import shutil
import statistics
import subprocess
import sys
import zipfile
from collections import Counter

from analyze import databases, query, target_wallets

CONTEXT_MINUTES = (1, 5, 15)

# A detector that logs liberally is right — a collapse that stopped short of a
# cent is still the denominator — but "the book emptied for a moment" is not an
# event. Significance is applied here rather than at collection so the raw log
# stays intact and the filter can be re-tuned without recollecting.
SIGNIFICANT_SWEEPS = """
    SELECT s.*, m.sport, m.level AS market_level, m.kind, m.question
    FROM sweeps s LEFT JOIN markets m ON m.condition_id = s.condition_id
    WHERE s.bid_after IS NOT NULL AND s.bid_before IS NOT NULL
      AND s.bid_before >= ? AND s.size_consumed >= ?
      AND s.bid_after < s.bid_before
    ORDER BY s.ts
"""


def dedupe(rows, key_index=0):
    """Keep the newest row per key.

    Registry tables live in every daily database, so reading a week of them
    concatenates seven copies of the same market. Left alone that turned a
    bundle meant to be tens of kilobytes into 25 MB.
    """
    seen = {}
    for row in rows:
        seen[row[key_index]] = row
    return list(seen.values())


def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return len(rows)


def sweep_context(paths, sweeps):
    """Every sweep, with what the book and gg.bet said around it."""
    rows = []
    for sweep in sweeps:
        prior = query(paths, """
            SELECT best_bid, size_at_001, size_at_002, size_at_003, size_at_005,
                   depth_bid_total, n_bid_levels
            FROM book WHERE asset_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"]))
        fair = query(paths, """
            SELECT ggbet_fair, dislocation_ratio, seconds_since_ggbet_quote, ggbet_market_state
            FROM joined WHERE asset_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"]))
        highs = []
        for minutes in CONTEXT_MINUTES:
            best = query(paths, """
                SELECT max(best_bid) AS high FROM book
                WHERE asset_id = ? AND ts > ? AND ts <= datetime(?, ?)
            """, (sweep["asset_id"], sweep["ts"], sweep["ts"], f"+{minutes} minutes"))
            highs.append(best[0]["high"] if best else None)

        # sqlite3.Row indexes like a tuple and a mapping but has no .get
        before = dict(prior[0]) if prior else {}
        quote = dict(fair[0]) if fair else {}
        rows.append([
            sweep["ts"], sweep["asset_id"], sweep["condition_id"], sweep["rule"],
            sweep["bid_before"], sweep["bid_after"], sweep["size_consumed"],
            sweep["levels_crossed"], sweep["depth_before"], sweep["depth_after"],
            before.get("size_at_001"), before.get("size_at_002"),
            before.get("size_at_003"), before.get("size_at_005"),
            before.get("depth_bid_total"), before.get("n_bid_levels"),
            quote.get("ggbet_fair"), quote.get("dislocation_ratio"),
            quote.get("seconds_since_ggbet_quote"), quote.get("ggbet_market_state"),
            *highs,
            sweep["sport"], sweep["market_level"], sweep["kind"], sweep["question"],
        ])
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data")
    parser.add_argument("--out", default="export")
    parser.add_argument("--since")
    parser.add_argument("--min-bid-before", type=float, default=0.05,
                        help="ignore collapses that started below this price")
    parser.add_argument("--min-consumed", type=float, default=100.0,
                        help="ignore collapses that ate less size than this")
    parser.add_argument("--max-sweeps", type=int, default=5000,
                        help="cap on how many sweeps get the expensive context")
    args = parser.parse_args()

    paths = databases(args.db, args.since)
    if not paths:
        raise SystemExit(f"no databases in {args.db}")
    shutil.rmtree(args.out, ignore_errors=True)
    os.makedirs(args.out, exist_ok=True)
    sizes = {}

    # analyze.py builds the helper indexes and prints its own progress to
    # stderr, which is left connected so a long first run does not look hung.
    print("running analyze.py (this builds indexes on a first run)...", flush=True)
    report = subprocess.run(
        [sys.executable, "analyze.py", "--db", args.db] + (["--since", args.since] if args.since else []),
        stdout=subprocess.PIPE, text=True)
    with open(os.path.join(args.out, "report.txt"), "w", encoding="utf-8") as handle:
        handle.write(report.stdout or "")

    print("reading sweeps...", flush=True)
    sweeps = query(paths, SIGNIFICANT_SWEEPS, (args.min_bid_before, args.min_consumed))
    raw = query(paths, "SELECT count(*) AS c FROM sweeps")
    raw_count = sum(r["c"] for r in raw)
    print(f"  {raw_count} sweeps logged, {len(sweeps)} pass the significance filter", flush=True)
    if len(sweeps) > args.max_sweeps:
        print(f"  capping at {args.max_sweeps} most recent for the priced extract", flush=True)
        sweeps = sweeps[-args.max_sweeps:]
    print(f"pricing {len(sweeps)} sweeps...", flush=True)
    sizes["sweeps.csv"] = write_csv(
        os.path.join(args.out, "sweeps.csv"),
        ["ts", "asset_id", "condition_id", "rule", "bid_before", "bid_after",
         "size_consumed", "levels_crossed", "depth_before", "depth_after",
         "prior_size_at_001", "prior_size_at_002", "prior_size_at_003", "prior_size_at_005",
         "prior_depth_bid_total", "prior_n_bid_levels",
         "ggbet_fair", "dislocation_ratio", "seconds_since_ggbet_quote", "ggbet_market_state",
         "high_1m", "high_5m", "high_15m", "sport", "market_level", "kind", "question"],
        sweep_context(paths, sweeps))

    print("reading markets, fills, coverage...", flush=True)
    markets = query(paths, """
        SELECT condition_id, asset_id_a, asset_id_b, question, event_slug, sport,
               level, kind, segment_kind, segment_no, line, team_a, team_b,
               end_date, tick_size, min_size, first_seen, last_seen FROM markets
    """)
    # Only the markets something else in the bundle refers to. The registry as a
    # whole is thirteen thousand rows and nothing joins against most of them.
    referenced = {row["condition_id"] for row in sweeps}
    referenced.update(row["condition_id"] for row in query(paths,
        "SELECT DISTINCT condition_id FROM trades"))
    kept = [list(r) for r in markets if r["condition_id"] in referenced]
    sizes["markets.csv"] = write_csv(os.path.join(args.out, "markets.csv"),
        list(markets[0].keys()) if markets else ["condition_id"], dedupe(kept))

    wallets = target_wallets()
    if wallets:
        placeholders = ",".join("?" * len(wallets))
        fills = query(paths, f"""
            SELECT t.ts, t.condition_id, t.asset_id, t.wallet, t.side, t.price, t.size,
                   t.role, t.tx_hash, m.question, m.sport, m.level AS market_level, m.kind
            FROM trades t LEFT JOIN markets m ON m.condition_id = t.condition_id
            WHERE lower(t.wallet) IN ({placeholders}) ORDER BY t.ts
        """, wallets)
        sizes["target-fills.csv"] = write_csv(os.path.join(args.out, "target-fills.csv"),
            list(fills[0].keys()) if fills else ["ts"], [list(r) for r in fills])

    # Per asset per hour is one row per token per hour and runs to megabytes.
    # What coverage is asked for is per sport per hour: how many tokens were
    # watched, and how completely.
    coverage = query(paths, """
        SELECT substr(b.ts, 1, 13) AS hour, coalesce(m.sport, '(unknown)') AS sport,
               count(DISTINCT b.asset_id) AS assets, count(*) AS heartbeats,
               min(b.best_bid) AS lowest_bid, max(b.best_bid) AS highest_bid
        FROM book b LEFT JOIN markets m ON m.condition_id = b.condition_id
        WHERE b.trigger = 'heartbeat' GROUP BY hour, sport ORDER BY hour
    """)
    sizes["coverage.csv"] = write_csv(os.path.join(args.out, "coverage.csv"),
        ["hour", "sport", "assets", "heartbeats", "lowest_bid", "highest_bid"],
        [list(r) for r in coverage])

    universe = query(paths, """
        SELECT ts, condition_id, discovered_via, subscribed, unsubscribed_at,
               reason_skipped, question, sport, level, kind
        FROM universe ORDER BY ts
    """)
    # The journal answers "what was considered and why was it passed over".
    # That is a count per sport and reason, not fifty thousand rows: the full
    # table is ten megabytes and no conversation will read it.
    seen = {}
    for row in universe:
        seen[row["condition_id"]] = row
    summary = {}
    for row in seen.values():
        key = (row["sport"] or "(unmapped)", int(row["subscribed"] or 0),
               row["reason_skipped"] or "")
        summary[key] = summary.get(key, 0) + 1
    sizes["universe-summary.csv"] = write_csv(
        os.path.join(args.out, "universe-summary.csv"),
        ["sport", "subscribed", "reason_skipped", "markets"],
        sorted(([k[0], k[1], k[2], n] for k, n in summary.items()), key=lambda r: -r[3]))

    gaps = query(paths, "SELECT started_at, ended_at, duration_ms, reason, assets_resubscribed FROM gaps ORDER BY started_at")
    sizes["gaps.csv"] = write_csv(os.path.join(args.out, "gaps.csv"),
        ["started_at", "ended_at", "duration_ms", "reason", "assets_resubscribed"],
        [list(r) for r in gaps])

    # The wallet side of the study: outcomes, the PnL report built from them,
    # and the positions whose history is incomplete.
    if os.path.exists("target-fills.csv"):
        fills_report = subprocess.run([sys.executable, "analyze_fills.py"],
                                      stdout=subprocess.PIPE, text=True)
        if fills_report.stdout:
            with open(os.path.join(args.out, "fills-report.txt"), "w", encoding="utf-8") as handle:
                handle.write(fills_report.stdout)
            sizes["fills-report.txt"] = "written"

    for name in ("pm-resolutions.csv", "pm-position-gaps.csv",
                 "mapping.csv", "pm.config.json"):
        if os.path.exists(name):
            shutil.copy(name, os.path.join(args.out, name))
            sizes[name] = "copied"

    # The project root may hold an earlier, larger fills export — the one the
    # resolutions were built from. It is not the same file as the one generated
    # from this collection, so it travels under its own name instead of
    # overwriting it.
    if os.path.exists("target-fills.csv"):
        shutil.copy("target-fills.csv", os.path.join(args.out, "target-fills-prior.csv"))
        sizes["target-fills-prior.csv"] = "copied"

    rules = Counter(r["rule"] for r in sweeps)
    swept = [r["bid_after"] for r in sweeps if r["bid_after"] is not None]
    with open(os.path.join(args.out, "README.md"), "w", encoding="utf-8") as handle:
        handle.write(DESCRIPTION.format(
            days=len(paths), files=", ".join(os.path.basename(p) for p in paths),
            sweeps=len(sweeps), rules=dict(rules), markets=len(markets),
            coverage_hours=len(coverage), gaps=len(gaps),
            median_after=f"{statistics.median(swept):.3f}" if swept else "n/a",
        ))

    # The wallet half of the bundle depends on files produced by other steps.
    # Leaving them out quietly is how an incomplete archive gets sent.
    fills_path = os.path.join(args.out, "target-fills.csv")
    steps = []
    if not os.path.exists("pm-resolutions.csv"):
        steps.append(f"node src/pm/resolve.mjs --from {fills_path}")
    if not os.path.exists(os.path.join(args.out, "fills-report.txt")):
        steps.append(f"python3 analyze_fills.py --fills {fills_path}")
    if steps:
        steps.append(f"python3 export.py --db {args.db}")

    with zipfile.ZipFile(f"{args.out}.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(os.listdir(args.out)):
            archive.write(os.path.join(args.out, name), name)

    print(f"wrote {args.out}/ and {args.out}.zip")
    for name, count in sizes.items():
        path = os.path.join(args.out, name)
        size = f"{os.path.getsize(path) / 1024:.0f} KB" if os.path.exists(path) else ""
        print(f"  {name:22} {str(count):>8}  {size}")
    archive_kb = os.path.getsize(f"{args.out}.zip") / 1024
    print(f"  archive               {archive_kb:.0f} KB")
    if archive_kb > 5000:
        print("  ! larger than a conversation will take. The biggest files above are"
              " the ones to trim or leave out.")
    if steps:
        print("\n  ! no PnL in this bundle — resolutions and the fills report are missing.")
        print("    This export just wrote the fills it needs. Run, in order:")
        for step in steps:
            print(f"      {step}")


DESCRIPTION = """# Polymarket / gg.bet collection extract

Collected by the repository this file came from. {days} day-file(s): {files}.

The raw store is a few gigabytes, almost all of it order-book snapshots. This
extract keeps what analysis needs and drops the bulk.

## What is here

| File | Contents |
|---|---|
| `report.txt` | output of `analyze.py`, the four headline questions |
| `sweeps.csv` | every detected book collapse, with its context ({sweeps} rows) |
| `markets.csv` | market registry: question, discipline, level, kind, segment ({markets} rows) |
| `target-fills.csv` | fills by the wallets under study in THIS collection, tagged maker or taker |
| `target-fills-prior.csv` | an earlier fills export, if one was in the project root — this is what `fills-report.txt` and the resolutions were built from |
| `coverage.csv` | heartbeats per asset per hour ({coverage_hours} rows) |
| `gaps.csv` | websocket disconnects ({gaps} rows) |
| `universe.csv` | every market considered, and why it was or was not subscribed |
| `target-fills.csv` | fills by the wallets under study in THIS collection, tagged maker or taker |
| `target-fills-prior.csv` | an earlier fills export, if one was in the project root — this is what `fills-report.txt` and the resolutions were built from |
| `pm-resolutions.csv` | which outcome won each market, and its metadata |
| `fills-report.txt` | position-level PnL: cost, revenue and exit mode per position |
| `pm-position-gaps.csv` | positions whose trade history is incomplete |
| `mapping.csv` | Polymarket market to gg.bet market correspondence |
| `pm.config.json` | thresholds the collection ran with |

## How to read sweeps.csv

One row per detected collapse of the bid side.

- `rule` — which detector fired: `bid_drop`, `levels`, `depth_collapse`, or a
  combination. Thresholds are in `pm.config.json`.
- `bid_before` / `bid_after` — best bid across the update. Median `bid_after`
  in this extract: {median_after}.
- `prior_size_at_00X` — resting bid size at 1, 2, 3 and 5 cents in the last
  snapshot *before* the sweep. This is the capacity question: how much of
  someone else's money already stands in the queue.
- `ggbet_fair` — de-vigged probability from gg.bet for the same question,
  taken from the newest quote at or before the sweep.
- `dislocation_ratio` — `ggbet_fair / pm_mid`. The central metric.
- `seconds_since_ggbet_quote` — age of that fair value. gg.bet writes only on
  a price change, so a large number means the fair is stale and the
  dislocation may be an artefact rather than an opportunity.
- `high_1m` / `high_5m` / `high_15m` — highest best bid after the sweep, the
  exit side of the payoff.

Rule counts in this extract: {rules}

## Caveats that matter

- A book *swept* to two cents and a book *resting* at two cents are different
  events; only the first is an opportunity, and `report.txt` reports them
  separately.
- `ggbet_fair` is null wherever the market could not be matched to gg.bet.
  Matching is fuzzy (team names plus a time window plus the same question at
  the same segment) and `mapping.csv` is hand-correctable; a row with
  `verified=1` was confirmed by a person.
- Tick size is per market: mostly 0.01, sometimes 0.001. A three-tick move is
  not a fixed number of cents.
- Coverage is counted from heartbeats. Hours with fewer than expected are
  incomplete, and dividing by them overstates any rate.
- `fills-report.txt` separates five exit modes. A position sold in part and
  left to resolve is neither sold nor held: it carries both proceeds and a
  payout, and pooling it with either corrupts that group's hit rate.
- A position with no buys means its purchases happened before collection
  started. Its size is a lower bound, and it is listed in
  `pm-position-gaps.csv` rather than silently averaged in.
- `universe.csv` is what separates "the bot never traded here" from "the logger
  never looked here". It only runs forward: markets seen before the journal
  existed are not in it, so a sample drawn from before that point still
  describes a slice of unknown origin.
"""


if __name__ == "__main__":
    main()
