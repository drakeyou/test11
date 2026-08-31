#!/usr/bin/env python3
"""Tests for the position accounting.

    python3 test_analyze_fills.py

A sign error here would be invisible and would change the conclusion, so the
fate classification and the arithmetic are pinned.
"""

from analyze_fills import summarize

def fill(side, price, size, ts, asset="tok1"):
    return {"ts": ts, "condition_id": "0xc1", "asset_id": asset, "wallet": "0xw",
            "side": side, "price": str(price), "size": str(size)}

WON = {"winner": "1", "closed": "1", "question": "q", "sport": "esports_counter_strike",
       "market_level": "segment"}
LOST = {**WON, "winner": "0"}
OPEN = {**WON, "closed": "0", "winner": ""}

def check(name, condition):
    assert condition, name

# Bought and never sold, outcome lost: the whole cost is gone. This is the
# common case and the one that survivorship bias hides.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")], LOST)
check("held_lost fate", p["fate"] == "held_lost")
check("held_lost cost", abs(p["cost"] - 20.0) < 1e-9)
check("held_lost revenue is zero", p["revenue"] == 0.0)
check("held_lost multiple is zero", p["multiple"] == 0.0)
check("held_lost complete", p["complete"])

# Same position, outcome won: redeemed at a dollar a share.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")], WON)
check("held_won fate", p["fate"] == "held_won")
check("held_won payout", abs(p["payout"] - 1000.0) < 1e-9)
check("held_won multiple", abs(p["multiple"] - 50.0) < 1e-9)

# Fully sold before resolution: the outcome no longer matters.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 1000, "2026-08-25T12:02:00Z")], LOST)
check("sold fate", p["fate"] == "sold")
check("sold revenue", abs(p["revenue"] - 80.0) < 1e-9)
check("sold multiple", abs(p["multiple"] - 4.0) < 1e-9)
check("sold has no payout", p["payout"] == 0.0)
check("sold records exit time", p["closed_at"] == "2026-08-25T12:02:00Z")

# Sold in part, remainder resolved. Neither "sold" nor "held": it carries both
# proceeds and a payout, and pooling it with either distorts that group.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 400, "2026-08-25T12:02:00Z")], LOST)
check("partial_lost fate", p["fate"] == "partial_lost")
check("partial_lost keeps proceeds", abs(p["revenue"] - 32.0) < 1e-9)
check("partial_lost remainder", abs(p["remaining"] - 600.0) < 1e-9)
check("partial_lost beats cost", p["multiple"] > 1)

p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 400, "2026-08-25T12:02:00Z")], WON)
check("partial_won fate", p["fate"] == "partial_won")
check("partial_won adds payout", abs(p["revenue"] - (32.0 + 600.0)) < 1e-9)

# Still open with a remainder: excluded rather than guessed at.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")], OPEN)
check("unresolved fate", p["fate"] == "unresolved")
check("unresolved has no revenue", p["revenue"] is None)
check("unresolved has no multiple", p["multiple"] is None)

# No resolution row at all is the same situation.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")], None)
check("missing resolution is unresolved", p["fate"] == "unresolved")

# A sell with no buy means the purchase happened before the logger watched.
p = summarize("tok1", [fill("SELL", 0.08, 871.9, "2026-08-25T12:02:00Z")], LOST)
check("sell without buy is incomplete", not p["complete"])
check("reason names it", p["reason"] == "no buys recorded")

# Selling more than was bought is the same defect seen from the other side.
p = summarize("tok1", [fill("BUY", 0.02, 100, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 500, "2026-08-25T12:02:00Z")], LOST)
check("oversold is incomplete", not p["complete"])
check("oversold reason", p["reason"] == "sells exceed buys")

# Averaging in: the entry price is the weighted average, not the first fill.
p = summarize("tok1", [fill("BUY", 0.01, 100, "2026-08-25T12:00:00Z"),
                       fill("BUY", 0.03, 100, "2026-08-25T12:01:00Z")], LOST)
check("entry price is weighted", abs(p["entry_price"] - 0.02) < 1e-9)
check("cost sums both buys", abs(p["cost"] - 4.0) < 1e-9)

# Rounding must not be mistaken for missing history.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 1000.0005, "2026-08-25T12:02:00Z")], LOST)
check("rounding tolerated", p["complete"])

# --- incomplete history ----------------------------------------------------
# The real case: a Dota position sold 3487.6 shares against 2615.7 seen bought,
# because the buys happened before the collection started. Taking the sale at
# face value credited it with revenue on shares it never held, and the position
# being dropped from the report instead is what put the headline PnL $1022 below
# a hand recount. Now the sale counts only up to what was bought.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.10, 800, "2026-08-25T12:05:00Z"),
                       fill("SELL", 0.10, 700, "2026-08-25T12:06:00Z")], LOST)
check("oversold is flagged", p["incomplete"] == 1 and not p["complete"])
check("oversold reason", p["reason"] == "sells exceed buys")
check("sold volume is capped at bought", abs(p["sold_size"] - 1000.0) < 1e-9)
check("proceeds stop at the cap", abs(p["proceeds"] - 100.0) < 1e-9)
check("nothing is left to redeem", p["remaining"] == 0.0)
check("oversold revenue", abs(p["revenue"] - 100.0) < 1e-9)

# The sells are taken in time order, not prorated: the earliest ones are the
# ones the recorded buys could have supplied.
p = summarize("tok1", [fill("BUY", 0.02, 100, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.50, 60, "2026-08-25T12:05:00Z"),
                       fill("SELL", 0.10, 90, "2026-08-25T12:06:00Z")], LOST)
check("FIFO proceeds", abs(p["proceeds"] - (60 * 0.50 + 40 * 0.10)) < 1e-9)

# A complete position is untouched by any of this.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z"),
                       fill("SELL", 0.08, 400, "2026-08-25T12:02:00Z")], WON)
check("partial is complete", p["complete"] and p["incomplete"] == 0)
check("partial sold size", abs(p["sold_size"] - 400.0) < 1e-9)
check("partial revenue", abs(p["revenue"] - (32.0 + 600.0)) < 1e-9)

# The payout comes from the resolution rather than an assumed dollar, so a
# market that settles at a fraction is not read as a full redemption.
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")],
              {**WON, "payout_price": "0.5"})
check("payout follows the resolution", abs(p["payout"] - 500.0) < 1e-9)
p = summarize("tok1", [fill("BUY", 0.02, 1000, "2026-08-25T12:00:00Z")],
              {**WON, "payout_price": ""})
check("a missing payout price still redeems at a dollar", abs(p["payout"] - 1000.0) < 1e-9)

print("all position accounting tests passed")
