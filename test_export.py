#!/usr/bin/env python3
"""Tests for the analysis-side helpers.

    python3 test_export.py

Three of these pin bugs that were silent: a timestamp comparison that excluded
every row, an aggregate read from the wrong daily file, and a sample described
as "the most recent N" that was in fact one day of a five-day collection.
"""

import datetime
import os
import sqlite3
import tempfile

from analyze import highest, highs_after, iso_shift, newest, parse_timestamp
from export import gap_seconds_by_hour, minutes_from, stratify


def check(name, condition):
    assert condition, name


# --- the horizon bound ------------------------------------------------------
# SQLite's datetime(ts, '+5 minutes') answers "2026-08-29 20:20:03": a space
# where the stored value has a T, no milliseconds, no Z. The comparison is
# between strings and "T" sorts above " ", so `ts <= datetime(...)` was false
# for every row ever written, and high_1m/5m/15m came out empty in all 5000
# exported sweeps.
check("iso_shift keeps the stored shape",
      iso_shift("2026-08-29T20:15:03.123Z", 5) == "2026-08-29T20:20:03.123Z")
check("iso_shift crosses the hour",
      iso_shift("2026-08-29T20:58:00.000Z", 5) == "2026-08-29T21:03:00.000Z")
check("iso_shift crosses midnight",
      iso_shift("2026-08-29T23:59:00.000Z", 15) == "2026-08-30T00:14:00.000Z")
check("the shifted bound sorts above the stamp it came from",
      iso_shift("2026-08-29T20:15:03.123Z", 5) > "2026-08-29T20:15:03.123Z")


# --- reading across daily files ---------------------------------------------
# query() runs the statement against every database and concatenates, so a
# "LIMIT 1" comes back once per file. Taking rows[0] read the oldest file.
rows = [
    {"ts": "2026-08-25T10:00:00Z", "high": 0.10},
    {"ts": "2026-08-29T10:00:00Z", "high": 0.90},
    {"ts": "2026-08-27T10:00:00Z", "high": None},
]
check("newest picks the latest across files", newest(rows)["ts"] == "2026-08-29T10:00:00Z")
check("highest ignores the empty files", highest(rows) == 0.90)
check("newest of nothing is nothing", newest([]) is None)
check("highest of nothing is nothing", highest([]) is None)


# --- highs_after end to end -------------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    paths = []
    for day, bid in (("2026-08-27", 0.30), ("2026-08-28", 0.55)):
        path = os.path.join(tmp, f"pm-{day}.sqlite")
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE book (ts TEXT, asset_id TEXT, best_bid REAL)")
        # Inside one minute, inside five, and well outside fifteen.
        db.executemany("INSERT INTO book VALUES (?,?,?)", [
            (f"{day}T12:00:30.000Z", "tok", bid / 3),
            (f"{day}T12:03:00.000Z", "tok", bid),
            (f"{day}T12:40:00.000Z", "tok", 0.99),
        ])
        db.commit()
        db.close()
        paths.append(path)

    first = highs_after(paths, "tok", "2026-08-27T12:00:00.000Z")
    check("a high inside one minute is found", abs(first[1][0] - 0.10) < 1e-9)
    check("a high inside five minutes is found", abs(first[5][0] - 0.30) < 1e-9)
    check("nothing outside fifteen leaks in", abs(first[15][0] - 0.30) < 1e-9)

    # The second day is the regression: with rows[0] this came back empty,
    # because the first file has nothing in that window.
    second = highs_after(paths, "tok", "2026-08-28T12:00:00.000Z")
    check("a later day is not read out of the first file", abs(second[5][0] - 0.55) < 1e-9)

    # A sweep with no book rows after it reports nothing, which is an answer.
    check("an unwatched window is empty",
          highs_after(paths, "tok", "2026-08-29T12:00:00.000Z")[5][0] is None)


# --- the sample -------------------------------------------------------------
# Ordered by time and cut with [-5000:], the extract was five thousand sweeps
# from the last day of a five-day run, described as "the most recent 5000 of
# 117616". Any frequency taken from its length was wrong.
sweeps = ([{"ts": f"2026-08-27T{h:02d}:00:00Z"} for h in range(4)]
          + [{"ts": f"2026-08-28T{h:02d}:00:00Z"} for h in range(20)])
sample, strata = stratify(sweeps, 8)
check("the cap is respected", len(sample) == 8)
check("both days are present", {row[0] for row in strata} == {"2026-08-27", "2026-08-28"})
check("a small day gives its remainder back",
      dict((row[0], row[2]) for row in strata) == {"2026-08-27": 4, "2026-08-28": 4})
check("the strata say what each day actually held",
      dict((row[0], row[1]) for row in strata) == {"2026-08-27": 4, "2026-08-28": 20})
check("the sample stays in time order",
      [row["ts"] for row in sample] == sorted(row["ts"] for row in sample))
check("a day is sampled across its span, not from one end",
      sample[-1]["ts"] == "2026-08-28T19:00:00Z")

everything, all_strata = stratify(sweeps, 100)
check("under the cap nothing is dropped", len(everything) == 24)
check("and the strata say so", all(row[1] == row[2] for row in all_strata))
check("no sweeps, no strata", stratify([], 10) == ([], []))


# --- deduplication ----------------------------------------------------------
# Registry rows repeat in every daily file and must collapse; fills that share
# a timestamp are different fills and must not.
from export import dedupe  # noqa: E402

markets = [["c1", "old"], ["c2", "x"], ["c1", "new"]]
check("the newest row per market survives", dedupe(markets) == [["c1", "new"], ["c2", "x"]])

same_second = [
    ["2026-09-02T15:24:55.000Z", "tokA", "c", "0xw", "BUY", 0.02, 500],
    ["2026-09-02T15:24:55.000Z", "tokA", "c", "0xw", "BUY", 0.02, 279],
    ["2026-09-02T15:24:55.000Z", "tokA", "c", "0xw", "BUY", 0.02, 500],
]
check("two fills in one second are two rows",
      len(dedupe(same_second, key_index=(0, 1, 3, 4, 5, 6))) == 2)
check("keyed on the timestamp alone they would collapse",
      len(dedupe(same_second, key_index=0)) == 1)


# --- blind time -------------------------------------------------------------
# 421 minutes of disconnects over 174 reconnects were being counted as watched.
blind = gap_seconds_by_hour([
    {"started_at": "2026-08-27T12:30:00.000Z", "ended_at": "", "duration_ms": 600_000},
])
check("a gap inside one hour lands in it", abs(blind["2026-08-27T12"] - 600) < 1e-6)

split = gap_seconds_by_hour([
    {"started_at": "2026-08-27T12:55:00.000Z", "ended_at": "", "duration_ms": 600_000},
])
check("a gap across the hour is split", abs(split["2026-08-27T12"] - 300) < 1e-6)
check("and the rest lands in the next hour", abs(split["2026-08-27T13"] - 300) < 1e-6)

long_gap = gap_seconds_by_hour([
    {"started_at": "2026-08-27T12:00:00.000Z", "ended_at": "", "duration_ms": 7_200_000},
])
check("a gap spanning whole hours fills them", abs(long_gap["2026-08-27T13"] - 3600) < 1e-6)
check("a malformed gap is skipped, not fatal",
      gap_seconds_by_hour([{"started_at": None, "ended_at": "", "duration_ms": 1}]) == {})


# --- timestamps -------------------------------------------------------------
# CLOB answers game_start_time as "2026-09-01 07:30:00+00": a space where ISO
# has a T, and a two-digit offset. datetime.fromisoformat only accepted those
# from 3.11, so on 3.10 every field derived from a match start came out empty
# on one machine and filled on another, with a ValueError guard hiding it.
UTC = datetime.timezone.utc
check("a Postgres-style offset is read",
      parse_timestamp("2026-09-01 07:30:00+00")
      == datetime.datetime(2026, 9, 1, 7, 30, tzinfo=UTC))
check("so is a compact one",
      parse_timestamp("2026-09-01T07:30:00+0000")
      == datetime.datetime(2026, 9, 1, 7, 30, tzinfo=UTC))
check("and a trailing Z",
      parse_timestamp("2026-09-01T07:30:00.000Z")
      == datetime.datetime(2026, 9, 1, 7, 30, tzinfo=UTC))
check("a non-UTC offset keeps its sign and minutes",
      parse_timestamp("2026-09-01 07:30:00-0730")
      == datetime.datetime(2026, 9, 1, 7, 30,
                           tzinfo=datetime.timezone(-datetime.timedelta(hours=7, minutes=30))))
check("a bare timestamp is UTC",
      parse_timestamp("2026-09-01T07:30:00") == datetime.datetime(2026, 9, 1, 7, 30, tzinfo=UTC))
check("a bare date is not mistaken for an offset",
      parse_timestamp("2026-09-01") == datetime.datetime(2026, 9, 1, tzinfo=UTC))
check("odd fractional digits are tolerated",
      parse_timestamp("2026-09-01T07:30:00.5Z")
      == datetime.datetime(2026, 9, 1, 7, 30, 0, 500000, tzinfo=UTC))
check("nothing is nothing", parse_timestamp(None) is None and parse_timestamp("") is None)
check("nonsense is nothing", parse_timestamp("whenever") is None)

# --- minutes from the first point -------------------------------------------
check("after the start is positive",
      minutes_from("2026-08-27 12:00:00+00", "2026-08-27T12:30:00.000Z") == 30.0)
check("before the start is negative",
      minutes_from("2026-08-27 12:00:00+00", "2026-08-27T11:45:00.000Z") == -15.0)
check("no start, no answer", minutes_from(None, "2026-08-27T12:00:00.000Z") is None)
check("no event, no answer", minutes_from("2026-08-27 12:00:00+00", None) is None)
check("a malformed stamp is not fatal", minutes_from("whenever", "2026-08-27T12:00:00Z") is None)

print("all analysis helper tests passed")
