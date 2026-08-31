#!/usr/bin/env python3
"""Answer the four questions the collector exists to measure.

    python3 analyze.py                      every database in ./data
    python3 analyze.py --db data --since 2026-08-25
    python3 analyze.py --sweep-level 0.02   what counts as "swept to a cent"

Standard library only: sqlite3 and statistics. The collector needs no
dependencies and neither does this.
"""

import argparse
import datetime
import glob
import json
import os
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict

HEARTBEAT_SECONDS = 5


def databases(directory, since):
    """Daily files, filtered by the date in the name."""
    found = sorted(glob.glob(os.path.join(directory, "pm-*.sqlite")))
    if since:
        found = [p for p in found if os.path.basename(p)[3:13] >= since]
    return found


def progress(text):
    """Stage markers go to stderr so the report on stdout stays pipeable."""
    print(f"  {text}...", file=sys.stderr, flush=True)


_CONNECTIONS = {}


def connect(path, writable=False):
    """Reuse connections. The per-sweep queries run five times per sweep, and
    opening a database for each of them costs more than the queries do."""
    key = (path, writable)
    if key not in _CONNECTIONS:
        uri = f"file:{path}" if writable else f"file:{path}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        _CONNECTIONS[key] = connection
    return _CONNECTIONS[key]


def query(paths, sql, params=()):
    rows = []
    for path in paths:
        try:
            rows.extend(connect(path).execute(sql, params).fetchall())
        except sqlite3.OperationalError as error:
            print(f"  ! {os.path.basename(path)}: {error}")
    return rows


_WITH_TABLE = {}


def with_table(paths, table):
    """The subset of databases that actually has this table.

    Tables were added as the collector grew, so a week of daily files is not a
    week of the same schema. Asking anyway works — query() catches it — but the
    complaint would be printed once per sweep per file.
    """
    key = (tuple(paths), table)
    if key not in _WITH_TABLE:
        keep = []
        for path in paths:
            found = connect(path).execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
                (table,)).fetchone()
            if found:
                keep.append(path)
        _WITH_TABLE[key] = keep
    return _WITH_TABLE[key]


def newest(rows, column="ts"):
    """The latest of rows gathered from several daily files.

    query() runs the statement against every database and concatenates the
    results, so a "ORDER BY ts DESC LIMIT 1" comes back once per file and
    rows[0] is the newest row of the OLDEST file. For a sweep on the last day
    of a collection that is a snapshot from days earlier, silently.
    """
    best = None
    for row in rows:
        if row[column] is None:
            continue
        if best is None or row[column] > best[column]:
            best = row
    return best


def highest(rows, column="high"):
    """The maximum across per-file aggregates, for the same reason as newest()."""
    values = [row[column] for row in rows if row[column] is not None]
    return max(values) if values else None


def iso_shift(ts, minutes):
    """Move a stored timestamp by minutes, in the format it is stored in.

    SQLite's datetime(ts, '+5 minutes') answers "2026-08-29 20:20:03": a space
    where the stored value has a T, and no milliseconds and no Z. The comparison
    is between strings, and "T" sorts above " ", so `ts <= datetime(...)` was
    false for every row ever written. That is why high_1m, high_5m and high_15m
    came out empty in all five thousand exported sweeps, and why the payoff
    section of the report had nothing in it.
    """
    stamp = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    moved = stamp + datetime.timedelta(minutes=minutes)
    return moved.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moved.microsecond // 1000:03d}Z"


def highs_after(paths, asset_id, ts, horizons=(1, 5, 15), sweep_id=None):
    """Highest best bid within each horizon after a sweep.

    Prefers what the collector recorded live in sweep_followups, which knows
    something this query cannot: a market that resolved before the horizon was
    up is worth its payout, not a missing measurement. Falls back to the book
    itself, so collections made before that table existed still answer.

    @returns {minutes: (high, resolved_before_horizon)}
    """
    recorded = {}
    if sweep_id:
        for row in query(with_table(paths, "sweep_followups"),
                         "SELECT horizon, high_bid, resolved_before_horizon"
                         " FROM sweep_followups WHERE sweep_id = ?", (sweep_id,)):
            recorded[row["horizon"]] = (row["high_bid"], row["resolved_before_horizon"])

    out = {}
    for minutes in horizons:
        if minutes in recorded:
            out[minutes] = recorded[minutes]
            continue
        best = query(paths, """
            SELECT max(best_bid) AS high FROM book
            WHERE asset_id = ? AND ts > ? AND ts <= ?
        """, (asset_id, ts, iso_shift(ts, minutes)))
        out[minutes] = (highest(best), 0)
    return out


def ensure_indexes(paths, quiet=False):
    """Add the indexes the questions below need, if collection predates them.

    Coverage filters on `trigger` and the fill rate on `best_bid`; without an
    index on either, both scan every row in the day and sort it in a temporary
    b-tree. On a full day that is minutes per question instead of seconds.
    Building them is a one-off cost and safe while the collector is running,
    since the store is in WAL mode.
    """
    wanted = {
        "book_trigger_asset_ts": "CREATE INDEX book_trigger_asset_ts ON book (trigger, asset_id, ts)",
        "book_bid_asset_ts": "CREATE INDEX book_bid_asset_ts ON book (best_bid, asset_id, ts)",
    }
    for path in paths:
        connection = connect(path, writable=True)
        have = {row["name"] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'")}
        missing = [sql for name, sql in wanted.items() if name not in have]
        if not missing:
            continue
        if not quiet:
            print(f"  building {len(missing)} index(es) on {os.path.basename(path)}"
                  f" — one-off, may take a few minutes", flush=True)
        for sql in missing:
            try:
                connection.execute(sql)
            except sqlite3.OperationalError as error:
                print(f"  ! could not index {os.path.basename(path)}: {error}")
        connection.commit()


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


def sweeps(paths, levels=(0.05, 0.03, 0.02), min_bid_before=0.05, min_consumed=100.0):
    """How deep the book actually got eaten, by discipline and market type.

    The detector logs liberally on purpose — a collapse that stopped short of a
    cent still belongs in the denominator — but a book blinking empty as the
    maker repositions is not an event. Significance is applied here so the raw
    log stays intact and the threshold can be retuned without recollecting.
    """
    rows = query(paths, """
        SELECT s.*, m.sport, m.level AS market_level, m.kind
        FROM sweeps s LEFT JOIN markets m ON m.condition_id = s.condition_id
        WHERE s.bid_after IS NOT NULL AND s.bid_before IS NOT NULL
          AND s.bid_before >= ? AND s.size_consumed >= ?
          AND s.bid_after < s.bid_before
    """, (min_bid_before, min_consumed))
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
        # Priced on the sweep row itself where the collector had a quote in
        # hand; the lookup below is for collections made before it did.
        row = dict(sweep)
        fair = row.get("ggbet_fair")
        ratio = row.get("dislocation_ratio")
        stale = row.get("seconds_since_ggbet_quote")
        if fair is None:
            before = newest(query(paths, """
                SELECT ts, ggbet_fair, dislocation_ratio, seconds_since_ggbet_quote
                FROM joined WHERE asset_id = ? AND ts <= ?
                ORDER BY ts DESC LIMIT 1
            """, (sweep["asset_id"], sweep["ts"])))
            if not before or before["ggbet_fair"] is None:
                continue
            fair = before["ggbet_fair"]
            ratio = before["dislocation_ratio"]
            stale = before["seconds_since_ggbet_quote"]

        highs = {minutes: high for minutes, (high, _) in highs_after(
            paths, sweep["asset_id"], sweep["ts"], horizons,
            dict(sweep).get("sweep_id")).items()}

        rows.append({
            "asset_id": sweep["asset_id"], "ts": sweep["ts"], "fair": fair,
            "ratio": ratio, "entry": sweep["bid_after"],
            "stale": stale, "highs": highs,
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


def target_wallets(path="pm.config.json"):
    """Addresses under study, from the collector's own config."""
    try:
        with open(path) as handle:
            return [a.lower() for a in json.load(handle).get("wallets", {}).get("addresses", [])]
    except (OSError, ValueError):
        return []


def ground_truth(paths, wallets):
    """What the target wallets actually did, and what the book looked like just
    before each passive fill.

    A trade record carries no role, so the collector recovers it as the
    difference between the taker-only and full trade logs. This is the only
    labelled data in the project: everything else is inference.
    """
    if not wallets:
        return None
    placeholders = ",".join("?" * len(wallets))
    fills = query(paths, f"""
        SELECT t.*, m.sport, m.level AS market_level, m.kind
        FROM trades t LEFT JOIN markets m ON m.condition_id = t.condition_id
        WHERE lower(t.wallet) IN ({placeholders})
        ORDER BY t.ts
    """, wallets)

    by_role = Counter(row["role"] for row in fills)
    entries = [row["price"] for row in fills if row["role"] == "maker" and row["side"] == "BUY"]
    # Historical fills mostly sit on markets that have since closed, which the
    # collector never saw and so cannot classify. Say that rather than "?".
    kinds = Counter(
        f"{row['sport']} {row['market_level']}/{row['kind']}" if row["sport"]
        else "(market closed before collection started)"
        for row in fills if row["role"] == "maker")

    # The book one snapshot before a passive buy: what the queue looked like at
    # the moment of the fill.
    context = []
    for row in fills:
        if row["role"] != "maker" or row["side"] != "BUY":
            continue
        before = query(paths, """
            SELECT best_bid, size_at_001, size_at_002 FROM book
            WHERE asset_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
        """, (row["asset_id"], row["ts"]))
        if before:
            context.append((row["price"], before[0]["best_bid"], before[0]["size_at_002"]))

    return {"fills": fills, "by_role": by_role, "entries": entries,
            "kinds": kinds, "context": context}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data", help="directory of daily databases")
    parser.add_argument("--since", help="earliest day, YYYY-MM-DD")
    parser.add_argument("--sweep-level", type=float, default=0.02)
    parser.add_argument("--config", default="pm.config.json", help="for the target wallet list")
    parser.add_argument("--min-bid-before", type=float, default=0.05,
                        help="ignore collapses that started below this price")
    parser.add_argument("--min-consumed", type=float, default=100.0,
                        help="ignore collapses that ate less size than this")
    parser.add_argument("--no-index", action="store_true",
                        help="skip building helper indexes (read-only media)")
    args = parser.parse_args()

    paths = databases(args.db, args.since)
    if not paths:
        raise SystemExit(f"no databases in {args.db}")
    print(f"reading {len(paths)} database(s): {', '.join(os.path.basename(p) for p in paths)}", flush=True)
    if not args.no_index:
        ensure_indexes(paths)
    print(flush=True)

    progress("measuring coverage")
    cover = coverage(paths)
    print("== coverage ==")
    # Counted from heartbeats only: a heartbeat is written on a timer whether or
    # not the book moved, so it is the one signal that proves we were watching.
    print(f"  market-hours by heartbeat : {cover['market_hours']}")
    print(f"  complete / partial        : {cover['complete']} / {cover['partial']}")
    print(f"  disconnects               : {cover['gaps']} totalling {cover['gap_seconds']:.0f}s")

    progress("reading sweeps")
    sweep_rows, depth, by_kind = sweeps(paths, min_bid_before=args.min_bid_before,
                                        min_consumed=args.min_consumed)
    raw = sum(r["c"] for r in query(paths, "SELECT count(*) AS c FROM sweeps"))
    rules = query(paths, "SELECT rule, count(*) AS c FROM sweeps GROUP BY rule ORDER BY c DESC")
    print("\n== sweeps ==")
    print(f"  logged by detector   : {raw}")
    for row in rules[:6]:
        print(f"      {row['c']:8}  {row['rule']}")
    print(f"  significant          : {len(sweep_rows)}"
          f"  (started >= {args.min_bid_before}, ate >= {args.min_consumed})")
    for level in (0.05, 0.03, 0.02):
        print(f"  reaching <= {level:.2f}     : {depth[level]}")
        for key, count in by_kind[level].most_common(5):
            print(f"      {count:5}  {key}")

    progress("computing fill rate")
    watched, swept, resting, kinds = fill_rate(paths, args.sweep_level)
    print(f"\n== fill rate (book SWEPT to <= {args.sweep_level:.2f}) ==")
    # Denominator here is every hour with any book row, heartbeat or not.
    print(f"  market-hours observed : {watched}")
    print(f"  market-hours swept   : {swept}")
    print(f"  fill rate            : {swept / watched:.4f}" if watched else "  fill rate: n/a")
    for key, count in kinds.most_common(8):
        print(f"      {count:5}  {key}")
    print(f"  for contrast, hours merely resting at <= {args.sweep_level:.2f}: {resting}")
    print("  (resting is not an opportunity: the queue was already there)")

    progress(f"pricing {len(sweep_rows)} sweeps")
    rows, cells = payoff_matrix(paths, sweep_rows)
    print(f"\n== payoff: fair before x dislocation -> max bid within 5 min ({len(rows)} sweeps priced) ==")
    if cells:
        print(f"  {'fair':>6} {'disloc':>8} {'n':>5} {'median high':>12} {'max':>8}")
        for (fair_bucket, ratio_bucket), highs in sorted(cells.items()):
            print(f"  {fair_bucket:>6.1f} {ratio_bucket:>8} {len(highs):>5}"
                  f" {statistics.median(highs):>12.3f} {max(highs):>8.3f}")
    else:
        print("  no sweep had a gg.bet fair value to compare against")

    progress("measuring capacity")
    sizes = capacity(paths, sweep_rows)
    print(f"\n== capacity: size resting at 2c before a sweep (n={len(sizes)}) ==")
    if sizes:
        for point, value in percentiles(sizes).items():
            print(f"  p{point:<3} {value:>12.1f}")
        print(f"  mean {statistics.mean(sizes):>11.1f}")
    else:
        print("  no sweeps with a prior snapshot yet")

    truth = ground_truth(paths, target_wallets(args.config))
    if truth and truth["fills"]:
        print(f"\n== ground truth: target wallet fills (n={len(truth['fills'])}) ==")
        print(f"  by role              : {dict(truth['by_role'])}")
        if truth["entries"]:
            print(f"  passive buys         : {len(truth['entries'])}")
            print(f"  entry price          : min {min(truth['entries']):.3f}"
                  f" median {statistics.median(truth['entries']):.3f}"
                  f" max {max(truth['entries']):.3f}")
            under = sum(1 for p in truth["entries"] if p <= 0.02)
            print(f"  bought at <= 0.02    : {under}/{len(truth['entries'])}")
        for key, count in truth["kinds"].most_common(6):
            print(f"      {count:5}  {key}")
        if truth["context"]:
            queued = [size for _, _, size in truth["context"] if size is not None]
            print(f"  book seen before fill: {len(truth['context'])} of them")
            if queued:
                print(f"  size already at 2c   : median {statistics.median(queued):.1f}")
        else:
            print("  no fill yet lines up with a book snapshot we recorded")

    if rows:
        rules = exit_rules(rows)
        print("\n== exit rule ==")
        print(f"  static 4x        : {rules['static_hits']}/{rules['n']} hit,"
              f" avg {rules['static_avg_multiple']:.2f}x")
        print(f"  0.5 x fair       : {rules['dynamic_hits']}/{rules['n']} hit,"
              f" avg {rules['dynamic_avg_multiple']:.2f}x")


if __name__ == "__main__":
    main()
