#!/usr/bin/env python3
"""Check that a collection is complete and internally consistent.

    python3 check.py

Reports on both halves — the gg.bet odds feed and the Polymarket book log —
and names what is missing rather than leaving it to be discovered in an
analysis. Standard library only; reads, never writes.
"""

import argparse
import csv
import datetime
import glob
import os
import sqlite3
import zipfile
from collections import Counter

EXPECTED_SPORTS = {
    "esports_counter_strike", "esports_dota_2", "esports_league_of_legends",
    "esports_valorant", "tennis",
}
TABLES = ["markets", "book", "sweeps", "joined", "wallets", "trades",
          "trade_scans", "universe", "gaps"]

OK, WARN, BAD = "  ok  ", " warn ", " MISS "
findings = []


def say(level, text, detail=""):
    findings.append(level)
    print(f"[{level}] {text}" + (f"\n{' ' * 9}{detail}" if detail else ""))


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def check_ggbet(odds_path, changes_path):
    print("\n== gg.bet: live odds ==")
    if not os.path.exists(odds_path):
        say(BAD, f"{odds_path} not found",
            "the odds collector has not written anything: run `npm run watch`")
        return
    rows = read_csv(odds_path)
    if not rows:
        say(BAD, f"{odds_path} is empty")
        return

    sports = Counter(r.get("sport", "") for r in rows)
    say(OK, f"{len(rows)} odds rows over {len({r['match_id'] for r in rows})} matches")
    missing = EXPECTED_SPORTS - set(sports)
    if missing:
        say(WARN, f"no rows for {len(missing)} of the five disciplines",
            f"{', '.join(sorted(missing))} — either none were live, or the "
            "collector ran without them (it defaults to all five)")
    else:
        say(OK, "all five disciplines present")
    for sport, count in sports.most_common():
        print(f"{' ' * 9}{count:>7}  {sport or '(blank)'}")

    span = sorted(r["ts"] for r in rows)
    say(OK, f"odds span {span[0][:16]} .. {span[-1][:16]}")

    if not os.path.exists(changes_path):
        say(WARN, f"{changes_path} not found", "the change log is not being written")
    else:
        changes = read_csv(changes_path)
        kinds = Counter(r.get("kind") for r in changes)
        say(OK, f"{len(changes)} change-log entries",
            ", ".join(f"{k}:{n}" for k, n in kinds.most_common(6)))


def check_databases(directory):
    print("\n== Polymarket: order book ==")
    paths = sorted(glob.glob(os.path.join(directory, "pm-*.sqlite")))
    if not paths:
        say(BAD, f"no databases in {directory}/", "run `npm run pm`")
        return []

    say(OK, f"{len(paths)} daily database(s): "
            f"{os.path.basename(paths[0])[3:13]} .. {os.path.basename(paths[-1])[3:13]}")

    totals = Counter()
    for path in paths:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        present = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for table in TABLES:
            if table in present:
                totals[table] += connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        absent = [t for t in TABLES if t not in present]
        if absent:
            say(WARN, f"{os.path.basename(path)} predates {', '.join(absent)}",
                "collected before those tables existed; no denominator for those days")
        connection.close()

    for table in TABLES:
        count = totals[table]
        level = OK if count else WARN
        say(level, f"{table:<12} {count:>10} rows")
    return paths


def check_coverage(paths):
    if not paths:
        return
    print("\n== coverage ==")
    hours = gaps = gap_ms = 0
    for path in paths:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            hours += connection.execute(
                "SELECT count(*) FROM (SELECT DISTINCT asset_id, substr(ts,1,13)"
                " FROM book WHERE trigger='heartbeat')").fetchone()[0]
            row = connection.execute(
                "SELECT count(*), coalesce(sum(duration_ms),0) FROM gaps").fetchone()
            gaps += row[0]
            gap_ms += row[1]
        except sqlite3.OperationalError:
            pass
        connection.close()

    say(OK if hours else WARN, f"{hours} market-hours carry heartbeats")
    if gaps:
        say(WARN, f"{gaps} disconnects totalling {gap_ms / 60000:.0f} minutes",
            "those windows were not observed and must not count as watched")
    else:
        say(OK, "no disconnects recorded")


def check_universe(paths):
    if not paths:
        return
    print("\n== what the logger looked at ==")
    subscribed = skipped = 0
    reasons = Counter()
    for path in paths:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            for row in connection.execute(
                    "SELECT subscribed, reason_skipped, count(*) FROM universe"
                    " GROUP BY subscribed, reason_skipped"):
                if row[0]:
                    subscribed += row[2]
                else:
                    skipped += row[2]
                    reasons[row[1]] += row[2]
        except sqlite3.OperationalError:
            pass
        connection.close()

    if not subscribed and not skipped:
        say(WARN, "the universe journal is empty",
            "it only runs forward: data collected before it existed has no denominator")
        return
    say(OK, f"{subscribed} markets subscribed, {skipped} passed over")
    for reason, count in reasons.most_common(5):
        print(f"{' ' * 9}{count:>7}  {reason}")


def check_sweeps(paths):
    if not paths:
        return
    print("\n== sweeps ==")
    logged = significant = 0
    for path in paths:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            logged += connection.execute("SELECT count(*) FROM sweeps").fetchone()[0]
            significant += connection.execute(
                "SELECT count(*) FROM sweeps WHERE bid_after IS NOT NULL"
                " AND bid_before >= 0.05 AND size_consumed >= 100"
                " AND bid_after < bid_before").fetchone()[0]
        except sqlite3.OperationalError:
            pass
        connection.close()

    if not logged:
        say(WARN, "no sweeps logged", "either the books were quiet or nothing was subscribed")
        return
    share = significant / logged
    say(OK, f"{logged} logged, {significant} significant ({share:.1%})")

    # Per day, because the detector guards only apply to what was collected
    # after them: a total mixes the two and hides whether they worked.
    print(f"{' ' * 9}{'day':<12}{'logged':>10}{'significant':>13}{'per market-hour':>17}")
    for path in paths:
        day = os.path.basename(path)[3:13]
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            n = connection.execute("SELECT count(*) FROM sweeps").fetchone()[0]
            sig = connection.execute(
                "SELECT count(*) FROM sweeps WHERE bid_after IS NOT NULL"
                " AND bid_before >= 0.05 AND size_consumed >= 100"
                " AND bid_after < bid_before").fetchone()[0]
            hours = connection.execute(
                "SELECT count(*) FROM (SELECT DISTINCT asset_id, substr(ts,1,13)"
                " FROM book WHERE trigger='heartbeat')").fetchone()[0]
        except sqlite3.OperationalError:
            connection.close()
            continue
        connection.close()
        rate = f"{sig / hours:.2f}" if hours else "n/a"
        print(f"{' ' * 9}{day:<12}{n:>10}{sig:>13}{rate:>17}")

    if significant > 20000:
        say(WARN, f"{significant} significant sweeps is not a count of events",
            "compare the per-day rate above: the detector guards only apply to days "
            "collected after them, so a falling rate means they worked")


def table_columns(path, table):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    except sqlite3.OperationalError:
        return set()
    finally:
        connection.close()


def check_window(paths, mapping_path, coverage_path):
    """Did the logger watch the matches, or only the hours before them?

    These are the readiness thresholds for the subscription window. The first
    two are the ones that matter: until the book is recorded while the match is
    being played, nothing downstream is measuring the thing it claims to.
    """
    if not paths:
        return
    print("\n== the subscription window ==")

    # Only matches that have actually been played. A market discovered for
    # tomorrow's game is waiting by design, and counting it as unwatched would
    # make a working schedule look broken.
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    # Only markets that were actually subscribed can have been watched. Gamma
    # keeps listing a market for hours after its match is over, so measuring
    # against every market whose game has passed counts matches that were
    # already finished when they were first seen — a property of the feed, not
    # of the schedule.
    played = subscribed = observed = undated = waiting = 0
    for path in paths:
        if "observed_during_game" not in table_columns(path, "markets"):
            continue
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = connection.execute("""
                SELECT count(*),
                       sum(subscribed_at IS NOT NULL),
                       sum(CASE WHEN subscribed_at IS NOT NULL
                                THEN coalesce(observed_during_game, 0) ELSE 0 END),
                       sum(game_start_time IS NULL)
                FROM markets WHERE game_start_time IS NULL OR game_start_time < ?
            """, (now,)).fetchone()
            played += row[0] or 0
            subscribed += row[1] or 0
            observed += row[2] or 0
            undated += row[3] or 0
            waiting += connection.execute(
                "SELECT count(*) FROM markets WHERE game_start_time >= ?", (now,)).fetchone()[0]
        except sqlite3.OperationalError:
            pass
        connection.close()

    if waiting:
        say(OK, f"{waiting} markets are scheduled for a match that has not started")
    late = played - subscribed
    if late:
        say(OK, f"{late} markets were first seen after their match was over",
            "Gamma lists a market for hours after the game; they are logged and let go")
    if not subscribed:
        say(WARN, "no market has been subscribed through a match yet",
            "these databases predate the window, or nothing has been watched yet")
    else:
        share = observed / subscribed
        detail = ("the window is dated from game_start_time; a subscribed market"
                  " with no book during its own match means the schedule fired but"
                  " the feed did not, so check the [feed] lines for reconnects")
        say(OK if share >= 0.8 else BAD,
            f"{observed}/{subscribed} subscribed markets ({share:.0%})"
            " were watched during their match",
            "" if share >= 0.8 else detail)
        if undated:
            say(WARN, f"{undated} markets carry no game start time",
                "they were scheduled off the resolution deadline, or not at all")

    # Sweeps priced against gg.bet, and sweeps whose outcome is known.
    priced = followed = swept = 0
    for path in paths:
        columns = table_columns(path, "sweeps")
        if "sweep_id" not in columns:
            continue
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            swept += connection.execute("SELECT count(*) FROM sweeps").fetchone()[0]
            priced += connection.execute(
                "SELECT count(*) FROM sweeps WHERE ggbet_fair IS NOT NULL").fetchone()[0]
            followed += connection.execute(
                "SELECT count(DISTINCT sweep_id) FROM sweep_followups"
                " WHERE horizon = 5 AND high_bid IS NOT NULL").fetchone()[0]
        except sqlite3.OperationalError:
            pass
        connection.close()

    if swept:
        share = followed / swept
        say(OK if share >= 0.9 else WARN,
            f"{followed}/{swept} sweeps ({share:.0%}) have a 5-minute high recorded",
            "" if share >= 0.9 else "sweeps in the last five minutes are still open;"
            " export.py fills the rest from the stored snapshots")
        share = priced / swept
        say(OK if share >= 0.2 else WARN,
            f"{priced}/{swept} sweeps ({share:.0%}) carry a gg.bet fair value",
            "" if share >= 0.2 else "the gg.bet collector was not running, or its"
            " matches are not the ones Polymarket listed")
        if share < 0.2:
            # The two sides can only meet on a discipline both of them carry.
            # Printed next to the gg.bet counts above, a mismatch is obvious:
            # one side heavy on tennis and the other on CS2 will never join,
            # however good the matcher is.
            watched = Counter()
            for path in paths:
                if "subscribed_at" not in table_columns(path, "markets"):
                    continue
                connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                try:
                    for row in connection.execute(
                        "SELECT coalesce(sport, '(none)'), count(*) FROM markets"
                        " WHERE subscribed_at IS NOT NULL GROUP BY 1"):
                        watched[row[0]] += row[1]
                except sqlite3.OperationalError:
                    pass
                connection.close()
            if watched:
                print(f"{' ' * 9}Polymarket markets watched, by discipline —"
                      f" compare with the gg.bet counts above:")
                for sport, count in watched.most_common(6):
                    print(f"{' ' * 9}  {count:8}  {sport}")

    # The mapping table, by what kind of market it actually pairs.
    if os.path.exists(mapping_path):
        rows = read_csv(mapping_path)
        winners = [r for r in rows if r.get("pm_level") == "segment"
                   and r.get("pm_kind") == "winner"]
        if not rows:
            say(WARN, f"{mapping_path} is empty")
        elif not any(r.get("pm_level") for r in rows):
            say(WARN, f"{mapping_path} predates the level and kind columns",
                "rerun the collector to see what the table actually pairs")
        else:
            share = len(winners) / len(rows)
            say(OK if share >= 0.5 else WARN,
                f"{len(winners)}/{len(rows)} mappings ({share:.0%}) are segment winners",
                "" if share >= 0.5 else "the studied wallets trade segment winners;"
                " a table of totals and handicaps prices the wrong markets")
        verified = sum(1 for r in rows if r.get("verified") in ("1", "true", "yes"))
        if rows and not verified:
            say(WARN, f"none of the {len(rows)} mappings has been verified by hand",
                "the join works, but its accuracy is unconfirmed")

    if os.path.exists(coverage_path):
        with open(coverage_path, newline="", encoding="utf-8") as handle:
            header = next(csv.reader(handle), [])
        say(OK if "gap_seconds" in header else WARN,
            f"coverage.csv {'carries' if 'gap_seconds' in header else 'has no'}"
            " gap_seconds column",
            "" if "gap_seconds" in header else "disconnects are not being subtracted"
            " from the observed time, so every per-hour rate is overstated")


def check_wallet(fills, resolutions, gaps_file):
    print("\n== wallet study ==")
    if not os.path.exists(fills):
        say(BAD, f"{fills} not found", "run: python3 export.py --db data")
        return
    rows = read_csv(fills)
    roles = Counter(r.get("role") for r in rows)
    say(OK, f"{len(rows)} fills over {len({r['asset_id'] for r in rows})} positions",
        ", ".join(f"{k}:{n}" for k, n in roles.items()))
    if "taker" not in roles:
        print(f"{' ' * 9}no taker fills — a measurement, not an absence, "
              "since both sides are stored")

    if not os.path.exists(resolutions):
        say(BAD, f"{resolutions} not found",
            f"run: node src/pm/resolve.mjs --from {fills}")
        return
    settled = read_csv(resolutions)
    closed = {r["condition_id"] for r in settled if r.get("closed") == "1"}
    wanted = {r["condition_id"] for r in rows}
    say(OK if len(closed & wanted) >= len(wanted) * 0.9 else WARN,
        f"{len(closed & wanted)}/{len(wanted)} traded markets have an outcome",
        "unresolved markets are excluded from PnL rather than guessed at")

    if os.path.exists(gaps_file):
        broken = read_csv(gaps_file)
        if broken:
            say(WARN, f"{len(broken)} positions have incomplete history",
                "their buys happened before collection; sizes are a lower bound")


def check_bundle(path):
    print("\n== export bundle ==")
    if not os.path.exists(path):
        say(WARN, f"{path} not found", "run: python3 export.py --db data")
        return
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        size = sum(i.compress_size for i in archive.infolist()) / 1024
    say(OK, f"{len(names)} files, {size:.0f} KB")
    for name in ("report.txt", "sweeps.csv", "universe-summary.csv",
                 "pm-resolutions.csv", "fills-report.txt"):
        if name not in names:
            say(WARN, f"{name} missing from the bundle")
    if size > 5000:
        say(WARN, "the bundle is larger than a conversation will take")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data")
    parser.add_argument("--odds", default="odds-history.csv")
    parser.add_argument("--changes", default="changes.csv")
    parser.add_argument("--fills", default="export/target-fills.csv")
    parser.add_argument("--resolutions",
                        default="pm-resolutions.csv" if os.path.exists("pm-resolutions.csv")
                        else "export/pm-resolutions.csv")
    parser.add_argument("--gaps", default="pm-position-gaps.csv")
    parser.add_argument("--mapping", default="mapping.csv")
    parser.add_argument("--coverage", default="export/coverage.csv")
    parser.add_argument("--bundle", default="export.zip")
    args = parser.parse_args()

    check_ggbet(args.odds, args.changes)
    paths = check_databases(args.db)
    check_coverage(paths)
    check_universe(paths)
    check_sweeps(paths)
    check_window(paths, args.mapping, args.coverage)
    check_wallet(args.fills, args.resolutions, args.gaps)
    check_bundle(args.bundle)

    print("\n" + "=" * 60)
    counts = Counter(findings)
    print(f"{counts[OK]} ok, {counts[WARN]} warnings, {counts[BAD]} missing")
    if counts[BAD]:
        print("Something required is absent — see the MISS lines above.")
    elif counts[WARN]:
        print("Usable, but read the warnings before trusting any rate: most of them "
              "are about denominators.")
    else:
        print("Everything the checks know how to verify is in place.")


if __name__ == "__main__":
    main()
