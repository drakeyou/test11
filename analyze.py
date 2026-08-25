#!/usr/bin/env python3
"""Answer the four questions the collector exists to measure.

    python3 analyze.py                      every database in ./data
    python3 analyze.py --db data --since 2026-08-25
    python3 analyze.py --sweep-level 0.02   what counts as "swept to a cent"

Standard library only: sqlite3 and statistics. The collector needs no
dependencies and neither does this.
"""

import argparse
import glob
import os
import sqlite3
import statistics
from collections import Counter, defaultdict

HEARTBEAT_SECONDS = 5


def databases(directory, since):
    """Daily files, filtered by the date in the name."""
    found = sorted(glob.glob(os.path.join(directory, "pm-*.sqlite")))
    if since:
        found = [p for p in found if os.path.basename(p)[3:13] >= since]
    return found


def query(paths, sql, params=()):
    rows = []
    for path in paths:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows.extend(connection.execute(sql, params).fetchall())
        except sqlite3.OperationalError as error:
            print(f"  ! {os.path.basename(path)}: {error}")
        finally:
            connection.close()
    return rows


def percentiles(values, points=(10, 25, 50, 75, 90, 99)):
    if not values:
        return {}
    ordered = sorted(values)
    return {p: ordered[min(len(ordered) - 1, int(len(ordered) * p / 100))] for p in points}


def coverage(paths):
    """Market-hours watched, and how many of them have holes.

    An hour is incomplete when it holds fewer heartbeats than the collector
    would have written had the feed stayed up. Dividing by an hour we did not
    actually observe is exactly how a fill rate gets quietly overstated.
    """
    rows = query(paths, """
        SELECT asset_id, substr(ts, 1, 13) AS hour, count(*) AS n
        FROM book WHERE trigger = 'heartbeat'
        GROUP BY asset_id, hour
    """)
    expected = 3600 // HEARTBEAT_SECONDS
    complete = sum(1 for r in rows if r["n"] >= expected * 0.9)
    gaps = query(paths, "SELECT started_at, ended_at, duration_ms, reason FROM gaps")
    return {
        "market_hours": len(rows),
        "complete": complete,
        "partial": len(rows) - complete,
        "gaps": len(gaps),
        "gap_seconds": sum(g["duration_ms"] for g in gaps) / 1000 if gaps else 0,
    }


def sweeps(paths, levels=(0.05, 0.03, 0.02)):
    """How deep the book actually got eaten, by discipline and market type."""
    rows = query(paths, """
        SELECT s.*, m.sport, m.level AS market_level, m.kind
        FROM sweeps s LEFT JOIN markets m ON m.condition_id = s.condition_id
    """)
    depth = Counter()
    by_kind = defaultdict(Counter)
    for row in rows:
        after = row["bid_after"]
        if after is None:
            continue
        for level in levels:
            if after <= level:
                depth[level] += 1
                key = f"{row['sport'] or '?'} {row['market_level'] or '?'}/{row['kind'] or '?'}"
                by_kind[level][key] += 1
    return rows, depth, by_kind


def fill_rate(paths, level):
    """Market-hours in which the book was SWEPT to `level`, over hours watched.

    This is the denominator the trade history cannot provide: an unfilled limit
    order leaves no record anywhere, so the only way to count the misses is to
    have been watching.

    A book swept down to two cents and a book that has quietly rested at two
    cents since it opened are not the same event, and only the first is an
    opportunity: resting there means the queue was already at that price and an
    order joining it sits behind everyone. Both are reported, separately.
    """
    watched = query(paths, """
        SELECT DISTINCT asset_id, substr(ts, 1, 13) AS hour FROM book
    """)
    swept = query(paths, """
        SELECT DISTINCT s.asset_id, substr(s.ts, 1, 13) AS hour, m.sport,
               m.level AS market_level, m.kind
        FROM sweeps s LEFT JOIN markets m ON m.condition_id = s.condition_id
        WHERE s.bid_after IS NOT NULL AND s.bid_after <= ?
    """, (level,))
    resting = query(paths, """
        SELECT DISTINCT asset_id, substr(ts, 1, 13) AS hour FROM book
        WHERE best_bid IS NOT NULL AND best_bid <= ?
    """, (level,))
    by_kind = Counter()
    for row in swept:
        by_kind[f"{row['sport'] or '?'} {row['market_level'] or '?'}/{row['kind'] or '?'}"] += 1
    return len(watched), len(swept), len(resting), by_kind


def payoff_matrix(paths, sweep_rows, horizons=(1, 5, 15)):
    """For each sweep: the fair before it, the dislocation, and what the price
    did afterwards. This is the table that replaces a threshold picked after the
    fact with one that was measured."""
    cells = defaultdict(list)
    rows = []
    for sweep in sweep_rows:
        if sweep["bid_after"] is None or sweep["bid_after"] > 0.05:
            continue
        before = query(paths, """
            SELECT ggbet_fair, dislocation_ratio, seconds_since_ggbet_quote
            FROM joined WHERE asset_id = ? AND ts <= ?
            ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"]))
        if not before or before[0]["ggbet_fair"] is None:
            continue
        fair = before[0]["ggbet_fair"]
        ratio = before[0]["dislocation_ratio"]

        highs = {}
        for minutes in horizons:
            best = query(paths, """
                SELECT max(best_bid) AS high FROM book
                WHERE asset_id = ? AND ts > ? AND ts <= datetime(?, ?)
            """, (sweep["asset_id"], sweep["ts"], sweep["ts"], f"+{minutes} minutes"))
            highs[minutes] = best[0]["high"] if best else None

        rows.append({
            "asset_id": sweep["asset_id"], "ts": sweep["ts"], "fair": fair,
            "ratio": ratio, "entry": sweep["bid_after"],
            "stale": before[0]["seconds_since_ggbet_quote"], "highs": highs,
        })
        fair_bucket = min(int(fair * 10) / 10, 0.9)
        ratio_bucket = "<5" if (ratio or 0) < 5 else "5-15" if ratio < 15 else "15+"
        if highs.get(5) is not None:
            cells[(fair_bucket, ratio_bucket)].append(highs[5])
    return rows, cells


def exit_rules(rows):
    """A static 4x exit against selling at half the gg.bet fair."""
    static_wins = dynamic_wins = 0
    static_total = dynamic_total = 0.0
    for row in rows:
        entry = row["entry"]
        high = row["highs"].get(15) or row["highs"].get(5) or row["highs"].get(1)
        if not entry or high is None:
            continue
        static_target = entry * 4
        dynamic_target = 0.5 * row["fair"]
        if high >= static_target:
            static_wins += 1
            static_total += static_target / entry
        if high >= dynamic_target:
            dynamic_wins += 1
            dynamic_total += dynamic_target / entry
    return {
        "n": len(rows),
        "static_hits": static_wins, "static_avg_multiple": static_total / max(static_wins, 1),
        "dynamic_hits": dynamic_wins, "dynamic_avg_multiple": dynamic_total / max(dynamic_wins, 1),
    }


def capacity(paths, sweep_rows):
    """Resting size at 2 cents just before a sweep: how much of someone else's
    money is already in the queue you would be joining."""
    sizes = []
    for sweep in sweep_rows:
        row = query(paths, """
            SELECT size_at_002 FROM book WHERE asset_id = ? AND ts < ?
            ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"]))
        if row and row[0]["size_at_002"] is not None:
            sizes.append(row[0]["size_at_002"])
    return sizes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data", help="directory of daily databases")
    parser.add_argument("--since", help="earliest day, YYYY-MM-DD")
    parser.add_argument("--sweep-level", type=float, default=0.02)
    args = parser.parse_args()

    paths = databases(args.db, args.since)
    if not paths:
        raise SystemExit(f"no databases in {args.db}")
    print(f"reading {len(paths)} database(s): {', '.join(os.path.basename(p) for p in paths)}\n")

    cover = coverage(paths)
    print("== coverage ==")
    print(f"  market-hours watched : {cover['market_hours']}")
    print(f"  complete / partial   : {cover['complete']} / {cover['partial']}")
    print(f"  disconnects          : {cover['gaps']} totalling {cover['gap_seconds']:.0f}s")

    sweep_rows, depth, by_kind = sweeps(paths)
    print("\n== sweeps ==")
    print(f"  detected             : {len(sweep_rows)}")
    for level in (0.05, 0.03, 0.02):
        print(f"  reaching <= {level:.2f}     : {depth[level]}")
        for key, count in by_kind[level].most_common(5):
            print(f"      {count:5}  {key}")

    watched, swept, resting, kinds = fill_rate(paths, args.sweep_level)
    print(f"\n== fill rate (book SWEPT to <= {args.sweep_level:.2f}) ==")
    print(f"  market-hours watched : {watched}")
    print(f"  market-hours swept   : {swept}")
    print(f"  fill rate            : {swept / watched:.4f}" if watched else "  fill rate: n/a")
    for key, count in kinds.most_common(8):
        print(f"      {count:5}  {key}")
    print(f"  for contrast, hours merely resting at <= {args.sweep_level:.2f}: {resting}")
    print("  (resting is not an opportunity: the queue was already there)")

    rows, cells = payoff_matrix(paths, sweep_rows)
    print(f"\n== payoff: fair before x dislocation -> max bid within 5 min ({len(rows)} sweeps priced) ==")
    if cells:
        print(f"  {'fair':>6} {'disloc':>8} {'n':>5} {'median high':>12} {'max':>8}")
        for (fair_bucket, ratio_bucket), highs in sorted(cells.items()):
            print(f"  {fair_bucket:>6.1f} {ratio_bucket:>8} {len(highs):>5}"
                  f" {statistics.median(highs):>12.3f} {max(highs):>8.3f}")
    else:
        print("  no sweep had a gg.bet fair value to compare against")

    sizes = capacity(paths, sweep_rows)
    print(f"\n== capacity: size resting at 2c before a sweep (n={len(sizes)}) ==")
    if sizes:
        for point, value in percentiles(sizes).items():
            print(f"  p{point:<3} {value:>12.1f}")
        print(f"  mean {statistics.mean(sizes):>11.1f}")
    else:
        print("  no sweeps with a prior snapshot yet")

    if rows:
        rules = exit_rules(rows)
        print("\n== exit rule ==")
        print(f"  static 4x        : {rules['static_hits']}/{rules['n']} hit,"
              f" avg {rules['static_avg_multiple']:.2f}x")
        print(f"  0.5 x fair       : {rules['dynamic_hits']}/{rules['n']} hit,"
              f" avg {rules['dynamic_avg_multiple']:.2f}x")


if __name__ == "__main__":
    main()
