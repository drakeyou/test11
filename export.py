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
import datetime
import os
import shutil
import statistics
import subprocess
import sys
import time
import zipfile
from collections import Counter, defaultdict

from analyze import (databases, highs_after, iso_shift, newest, query,
                     target_wallets, with_table)

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


def stratify(sweeps, cap):
    """A sample with equal quotas per day, instead of the newest N.

    Taking the tail of a run ordered by time gave five thousand sweeps that were
    all from the last day, in a bundle described as "the most recent 5000 of
    117616". Any frequency computed from the length of that file is wrong, and
    nothing in the file said so.

    Days that hold fewer sweeps than their quota give the remainder back to the
    others, and within a day the sample is spread evenly rather than taken from
    one end, so the hours of the day survive too.

    @returns (sample, strata) where strata is [day, significant, exported]
    """
    by_day = defaultdict(list)
    for sweep in sweeps:
        by_day[str(sweep["ts"])[:10]].append(sweep)
    days = sorted(by_day)
    if not days:
        return [], []
    if len(sweeps) <= cap:
        return sweeps, [[day, len(by_day[day]), len(by_day[day])] for day in days]

    sample = []
    strata = []
    left = cap
    # Smallest days first: a day that cannot fill its quota releases the rest.
    for index, day in enumerate(sorted(days, key=lambda d: len(by_day[d]))):
        quota = left // (len(days) - index)
        rows = by_day[day]
        take = min(len(rows), quota)
        if take >= len(rows):
            picked = rows
        elif take == 1:
            picked = [rows[len(rows) // 2]]
        else:
            step = (len(rows) - 1) / (take - 1)
            picked = [rows[round(i * step)] for i in range(take)]
        sample.extend(picked)
        strata.append([day, len(rows), len(picked)])
        left -= len(picked)
    sample.sort(key=lambda row: row["ts"])
    strata.sort()
    return sample, strata


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


def gap_seconds_by_hour(gaps):
    """Split each disconnect across the hours it covers.

    A gap is recorded as one row with a start and an end, but coverage is read
    per hour, and a gap that straddles the hour belongs to both.
    """
    blind = defaultdict(float)
    for gap in gaps:
        try:
            started = datetime.datetime.fromisoformat(
                str(gap["started_at"]).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        remaining = (gap["duration_ms"] or 0) / 1000.0
        at = started
        while remaining > 0:
            hour_end = (at + datetime.timedelta(hours=1)).replace(
                minute=0, second=0, microsecond=0)
            slice_seconds = min(remaining, (hour_end - at).total_seconds())
            blind[at.strftime("%Y-%m-%dT%H")] += slice_seconds
            remaining -= slice_seconds
            at = hour_end
    return blind


def has_column(paths, table, column):
    """Databases whose table carries this column.

    Columns were added as the collector grew; a week of daily files is not a
    week of the same schema.
    """
    keep = []
    for path in with_table(paths, table):
        names = {row["name"] for row in query([path], f"PRAGMA table_info({table})")}
        if column in names:
            keep.append(path)
    return keep


def game_starts(paths, resolutions_path="pm-resolutions.csv"):
    """condition_id -> when the match started.

    Read from the registry where the collector recorded it, and from the
    resolution file otherwise, which is what makes the field answerable for
    collections made before the registry carried it.
    """
    starts = {}
    for row in query(has_column(paths, "markets", "game_start_time"),
                     "SELECT condition_id, game_start_time FROM markets"
                     " WHERE game_start_time IS NOT NULL"):
        starts[row["condition_id"]] = row["game_start_time"]
    if os.path.exists(resolutions_path):
        with open(resolutions_path, newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                start = (row.get("game_start_time") or "").strip()
                if start and row.get("condition_id"):
                    starts.setdefault(row["condition_id"], start)
    return starts


def resolution_labels(path="pm-resolutions.csv"):
    """condition_id -> what the market was, from the resolution file.

    The registry only holds markets the collector subscribed to, and the wallets
    trade in disciplines it never watches, so joining fills against it alone
    left level and kind empty in 2195 rows out of 2200. The resolver classifies
    every market it fetches, which is exactly the gap.
    """
    labels = {}
    if not os.path.exists(path):
        return labels
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            key = row.get("condition_id")
            if not key or key in labels:
                continue
            labels[key] = {
                "question": row.get("question") or None,
                "sport": row.get("sport") or None,
                "market_level": row.get("market_level") or None,
                "kind": row.get("kind") or None,
                "segment_no": row.get("segment_no") or None,
            }
    return labels


def minutes_from(start, ts):
    """Minutes from the match start to an event, negative before the first point."""
    if not start or not ts:
        return None
    try:
        began = datetime.datetime.fromisoformat(
            str(start).strip().replace(" ", "T").replace("Z", "+00:00"))
        at = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    if began.tzinfo is None:
        began = began.replace(tzinfo=datetime.timezone.utc)
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    return round((at - began).total_seconds() / 60, 2)


def sweep_context(paths, sweeps, starts=None, report_every=100):
    """Every sweep, with what the book and gg.bet said around it.

    This is the long step of the export — several queries per sweep — so it
    says where it is. Silence for half an hour is indistinguishable from a
    hang, and a run that looks hung gets killed.
    """
    starts = starts if starts is not None else {}
    rows = []
    began = time.monotonic()
    for index, sweep in enumerate(sweeps):
        if report_every and index and index % report_every == 0:
            done = time.monotonic() - began
            rate = index / done if done else 0
            left = (len(sweeps) - index) / rate if rate else 0
            # Seconds when there are seconds left: "about 0.0 min left" on a run
            # that finishes in two is noise pretending to be information.
            remaining = f"{left / 60:.0f} min" if left >= 90 else f"{left:.0f}s"
            print(f"    {index}/{len(sweeps)} sweeps priced"
                  f" ({rate:.0f}/s, {remaining} left)", flush=True)
        # newest() across files, not rows[0]: query() asks every daily database
        # and returns one "latest row" per file, so the first of them is the
        # newest row of the oldest day — days away from the sweep being priced.
        prior = newest(query(paths, """
            SELECT ts, best_bid, size_at_001, size_at_002, size_at_003, size_at_005,
                   depth_bid_total, n_bid_levels
            FROM book WHERE asset_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"])))
        # Only worth asking when the collector had no quote in hand at the time.
        # The lookup is a scan of the joined table per sweep per daily file, and
        # on rows that already carry the quote it can only confirm them.
        row = dict(sweep)
        fair = None if row.get("ggbet_fair") is not None else newest(query(paths, """
            SELECT ts, ggbet_fair, dislocation_ratio, seconds_since_ggbet_quote,
                   ggbet_market_state
            FROM joined WHERE asset_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
        """, (sweep["asset_id"], sweep["ts"])))
        # sqlite3.Row indexes like a tuple and a mapping but has no .get
        sweep_id = row.get("sweep_id")
        followed = highs_after(paths, sweep["asset_id"], sweep["ts"],
                               CONTEXT_MINUTES, sweep_id)
        highs = [followed[minutes][0] for minutes in CONTEXT_MINUTES]
        settled = [followed[minutes][1] for minutes in CONTEXT_MINUTES]

        before = dict(prior) if prior else {}
        # The collector prices the sweep as it happens, from the resident cache
        # of gg.bet quotes. The lookup is the fallback for rows written before
        # it did, where it finds a quote about one time in five thousand.
        quote = dict(fair) if fair else {}
        if row.get("ggbet_fair") is not None:
            quote = {
                "ggbet_fair": row.get("ggbet_fair"),
                "dislocation_ratio": row.get("dislocation_ratio"),
                "seconds_since_ggbet_quote": row.get("seconds_since_ggbet_quote"),
                "ggbet_market_state": row.get("ggbet_market_state"),
            }
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
            sweep_id, *settled,
            minutes_from(starts.get(sweep["condition_id"]), sweep["ts"]),
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
    span = (f"{sweeps[0]['ts'][:19]} .. {sweeps[-1]['ts'][:19]}" if sweeps else "none")
    sweeps, strata = stratify(sweeps, args.max_sweeps)
    if len(strata) > 1 and sum(row[1] for row in strata) > len(sweeps):
        print(f"  sampling {len(sweeps)} of them, evenly across {len(strata)} days", flush=True)
    sizes["sweeps-strata.csv"] = write_csv(
        os.path.join(args.out, "sweeps-strata.csv"),
        ["day", "significant", "exported"], strata)
    starts = game_starts(paths)
    print(f"pricing {len(sweeps)} sweeps...", flush=True)
    sizes["sweeps.csv"] = write_csv(
        os.path.join(args.out, "sweeps.csv"),
        ["ts", "asset_id", "condition_id", "rule", "bid_before", "bid_after",
         "size_consumed", "levels_crossed", "depth_before", "depth_after",
         "prior_size_at_001", "prior_size_at_002", "prior_size_at_003", "prior_size_at_005",
         "prior_depth_bid_total", "prior_n_bid_levels",
         "ggbet_fair", "dislocation_ratio", "seconds_since_ggbet_quote", "ggbet_market_state",
         "high_1m", "high_5m", "high_15m", "sport", "market_level", "kind", "question",
         # Appended, never reordered: something downstream reads these by index.
         "sweep_id", "resolved_before_1m", "resolved_before_5m", "resolved_before_15m",
         "minutes_from_game_start"],
        sweep_context(paths, sweeps, starts))

    print("reading markets, fills, coverage...", flush=True)
    markets = query(paths, """
        SELECT condition_id, asset_id_a, asset_id_b, question, event_slug, sport,
               level, kind, segment_kind, segment_no, line, team_a, team_b,
               end_date, tick_size, min_size, first_seen, last_seen FROM markets
    """)
    # The subscription window, read separately because a database written before
    # it existed has none of these columns. observed_during_game is the whole
    # point: it says, without any analysis, whether the book was recorded while
    # the match was being played or only in the hours before it.
    lifecycle = {}
    for row in query(has_column(paths, "markets", "observed_during_game"), """
        SELECT condition_id, game_start_time, subscribed_at, unsubscribed_at,
               release_reason, coalesce(observed_during_game, 0) AS observed_during_game
        FROM markets
    """):
        # Later files win, and a market seen in play stays seen in play.
        seen = lifecycle.get(row["condition_id"])
        merged = dict(row)
        if seen:
            merged["observed_during_game"] = max(
                seen["observed_during_game"], merged["observed_during_game"])
        lifecycle[row["condition_id"]] = merged

    extra = ["game_start_time", "subscribed_at", "unsubscribed_at",
             "release_reason", "observed_during_game"]
    # Only the markets something else in the bundle refers to. The registry as a
    # whole is thirteen thousand rows and nothing joins against most of them.
    referenced = {row["condition_id"] for row in sweeps}
    referenced.update(row["condition_id"] for row in query(paths,
        "SELECT DISTINCT condition_id FROM trades"))
    kept = []
    for row in markets:
        if row["condition_id"] not in referenced:
            continue
        window = lifecycle.get(row["condition_id"], {})
        kept.append(list(row) + [window.get(name) for name in extra])
    sizes["markets.csv"] = write_csv(os.path.join(args.out, "markets.csv"),
        (list(markets[0].keys()) if markets else ["condition_id"]) + extra,
        dedupe(kept))

    wallets = target_wallets()
    if wallets:
        placeholders = ",".join("?" * len(wallets))
        fills = query(paths, f"""
            SELECT t.ts, t.condition_id, t.asset_id, t.wallet, t.side, t.price, t.size,
                   t.role, t.tx_hash, m.question, m.sport, m.level AS market_level, m.kind
            FROM trades t LEFT JOIN markets m ON m.condition_id = t.condition_id
            WHERE lower(t.wallet) IN ({placeholders}) ORDER BY t.ts
        """, wallets)
        # Three things that are cheap here and expensive to reconstruct later.
        #
        # fill_index is the strongest signal found in the data so far — positions
        # filled four or more times returned 0.46x against 1.97x for those filled
        # two or three times — and it is known at the moment of entry. It counts
        # fills of the same side on the same token, in time order, so the fourth
        # buy is fill_index 4 whatever the sells did.
        labels = resolution_labels()
        seen_fills = Counter()
        priced_fills = []
        for fill in fills:
            row = dict(fill)
            meta = labels.get(row["condition_id"], {})
            for field in ("question", "sport", "market_level", "kind"):
                if not row.get(field):
                    row[field] = meta.get(field)
            key = (row["asset_id"], row["side"])
            seen_fills[key] += 1
            row["fill_index"] = seen_fills[key]
            row["minutes_from_game_start"] = minutes_from(
                starts.get(row["condition_id"]), row["ts"])
            priced_fills.append(row)
        fill_columns = (list(fills[0].keys()) if fills else
                        ["ts", "condition_id", "asset_id", "wallet", "side", "price",
                         "size", "role", "tx_hash", "question", "sport", "market_level",
                         "kind"]) + ["fill_index", "minutes_from_game_start"]
        sizes["target-fills.csv"] = write_csv(os.path.join(args.out, "target-fills.csv"),
            fill_columns, [[row.get(name) for name in fill_columns] for row in priced_fills])

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
    # Seconds of that hour nobody saw. Without this the denominator counts the
    # disconnects as watched time: 421 minutes over 174 reconnects in the last
    # full run, silently inflating every rate computed per market-hour.
    blind = gap_seconds_by_hour(query(paths,
        "SELECT started_at, ended_at, duration_ms FROM gaps"))
    sizes["coverage.csv"] = write_csv(os.path.join(args.out, "coverage.csv"),
        ["hour", "sport", "assets", "heartbeats", "lowest_bid", "highest_bid", "gap_seconds"],
        [list(r) + [round(blind.get(r["hour"], 0.0), 1)] for r in coverage])

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
    #
    # The fills to report on are the ones this export just wrote. A project root
    # may also hold an earlier, larger export; that one wins, because it is what
    # the resolutions were built from. Looking only at the root file — as this
    # did — left the report out of every bundle on a machine that never had one.
    fills_path = os.path.join(args.out, "target-fills.csv")
    for_report = next((p for p in ("target-fills.csv", fills_path) if os.path.exists(p)), None)
    report_error = None
    if for_report:
        fills_report = subprocess.run(
            [sys.executable, "analyze_fills.py", "--fills", for_report],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if fills_report.returncode == 0 and fills_report.stdout:
            with open(os.path.join(args.out, "fills-report.txt"), "w", encoding="utf-8") as handle:
                handle.write(fills_report.stdout)
            sizes["fills-report.txt"] = "written"
        else:
            # Its own message says what is missing; swallowing it here is how the
            # bundle ends up short with no explanation.
            report_error = (fills_report.stderr or fills_report.stdout).strip()

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
            span=span, significant=sum(row[1] for row in strata),
            strata=", ".join(f"{row[0]}: {row[2]}/{row[1]}" for row in strata) or "none",
        ))

    # The wallet half of the bundle depends on files produced by other steps.
    # Leaving them out quietly is how an incomplete archive gets sent.
    steps = []
    missing = []
    if not os.path.exists("pm-resolutions.csv"):
        missing.append("the market outcomes")
        steps.append(f"node src/pm/resolve.mjs --from {fills_path}")
    if not os.path.exists(os.path.join(args.out, "fills-report.txt")):
        missing.append("the position report")
        steps.append(f"python3 analyze_fills.py --fills {for_report or fills_path}")
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
        absent = " and ".join(missing)
        print(f"\n  ! no PnL in this bundle — {absent} "
              f"{'are' if len(missing) > 1 else 'is'} missing.")
        if report_error:
            print("    " + report_error.replace("\n", "\n    "))
        print("    This export just wrote the fills it needs. Run, in order:")
        for step in steps:
            print(f"      {step}")


DESCRIPTION = """# Polymarket / gg.bet collection extract

Collected by the repository this file came from. {days} day-file(s): {files}.

Sweeps in this extract span {span}. That is the range of the *sample*; see
`sweeps-strata.csv` for how many significant sweeps each day actually held.

The raw store is a few gigabytes, almost all of it order-book snapshots. This
extract keeps what analysis needs and drops the bulk.

## What is here

| File | Contents |
|---|---|
| `report.txt` | output of `analyze.py`, the four headline questions |
| `sweeps.csv` | detected book collapses, with context ({sweeps} rows sampled from {significant} significant) |
| `sweeps-strata.csv` | how many significant sweeps each day held, and how many are here |
| `markets.csv` | market registry: question, discipline, level, kind, segment, and the subscription window ({markets} rows) |
| `target-fills.csv` | fills by the wallets under study in THIS collection, tagged maker or taker |
| `target-fills-prior.csv` | an earlier fills export, if one was in the project root — this is what `fills-report.txt` and the resolutions were built from |
| `coverage.csv` | heartbeats per asset per hour, with the seconds nobody saw ({coverage_hours} rows) |
| `gaps.csv` | websocket disconnects ({gaps} rows) |
| `universe.csv` | every market considered, and why it was or was not subscribed |
| `target-fills.csv` | fills by the wallets under study in THIS collection, tagged maker or taker |
| `target-fills-prior.csv` | an earlier fills export, if one was in the project root — this is what `fills-report.txt` and the resolutions were built from |
| `pm-resolutions.csv` | which outcome won each market, and its metadata |
| `fills-report.txt` | position-level PnL: cost, revenue and exit mode per position |
| `pm-position-gaps.csv` | positions whose trade history is incomplete |
| `mapping.csv` | Polymarket market to gg.bet market correspondence |
| `pm.config.json` | thresholds and the subscription window the collection ran with |

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
  exit side of the payoff. Recorded live by the collector where it was running,
  and computed from the stored snapshots otherwise.
- `resolved_before_1m` / `_5m` / `_15m` — 1 when the market resolved before that
  horizon was up. The `high_*` beside it is then the payout, not a bid: without
  this flag a settled market and a market nobody bid in look the same.
- `minutes_from_game_start` — minutes from the first point of the match,
  negative before it started.

Sample per day (exported/significant): {strata}

## How to read markets.csv

- `game_start_time` — when the match started. The subscription window is built
  on it; `end_date` is a resolution deadline (game + 6h for CS2, game + a week
  for tennis) and dates nothing.
- `subscribed_at` / `unsubscribed_at` / `release_reason` — when the book was
  watched, and why watching stopped: `resolved`, `past the hold window`, or
  `window passed unwatched` (the market was first seen after its match).
- `observed_during_game` — 1 when book snapshots exist inside the match itself.
  This is the self-check: rows with 0 were never watched in play, and nothing
  measured on them describes what happened during the match.

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
