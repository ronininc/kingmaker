#!/usr/bin/env python3
"""
deal_calc.py — deterministic wholesale deal math (Stage 5).

Computes repair estimate, Max Allowable Offer (MAO), suggested contract price,
and assignment spread so the numbers are consistent and never eyeballed.

MAO (70% rule, adjustable):
    MAO = ARV * buyer_pct - repairs - assignment_fee

Usage:
    python deal_calc.py --arv 300000 --sqft 1450 --tier medium \
        --assignment-fee 12000 --buyer-pct 0.70

    # Or give repairs directly instead of tier+sqft:
    python deal_calc.py --arv 300000 --repairs 45000 --assignment-fee 12000

Repair tiers are rough $/sqft budgeting estimates ONLY — a contractor walk-through
governs before close. Adjust tier rates per market with --rate.
"""
import argparse

TIER_RATES = {"light": 20.0, "medium": 40.0, "heavy": 65.0}  # $ per sqft, editable


def money(x: float) -> str:
    return "${:,.0f}".format(x)


def main() -> None:
    p = argparse.ArgumentParser(description="Wholesale deal calculator")
    p.add_argument("--arv", type=float, required=True, help="After-repair value from comps")
    p.add_argument("--sqft", type=float, help="Living area sqft (for tier-based repairs)")
    p.add_argument("--tier", choices=TIER_RATES.keys(), help="Repair severity tier")
    p.add_argument("--rate", type=float, help="Override $/sqft repair rate")
    p.add_argument("--repairs", type=float, help="Explicit repair $ (overrides tier)")
    p.add_argument("--assignment-fee", type=float, default=10000.0, help="Target wholesale fee")
    p.add_argument("--buyer-pct", type=float, default=0.70,
                   help="Buyer's cost basis as %% of ARV (0.70 = 70%% rule)")
    p.add_argument("--closing-costs", type=float, default=0.0,
                   help="Optional est. closing/holding costs to subtract")
    args = p.parse_args()

    # Repairs
    if args.repairs is not None:
        repairs = args.repairs
        repair_basis = "explicit"
    elif args.sqft and (args.tier or args.rate):
        rate = args.rate if args.rate is not None else TIER_RATES[args.tier]
        repairs = args.sqft * rate
        repair_basis = "{} @ ${:.0f}/sqft x {:.0f} sqft".format(
            args.tier or "custom", rate, args.sqft)
    else:
        raise SystemExit("Provide --repairs, or --sqft with --tier/--rate.")

    mao = args.arv * args.buyer_pct - repairs - args.assignment_fee - args.closing_costs
    buyer_all_in = mao + repairs + args.assignment_fee  # what the end buyer effectively pays in
    buyer_margin = args.arv - buyer_all_in
    buyer_margin_pct = (buyer_margin / args.arv * 100) if args.arv else 0.0

    print("=" * 48)
    print("WHOLESALE DEAL SUMMARY")
    print("=" * 48)
    print("ARV (from comps):        {}".format(money(args.arv)))
    print("Repairs ({}): {}".format(repair_basis, money(repairs)))
    print("Buyer % of ARV:          {:.0%}".format(args.buyer_pct))
    print("Target assignment fee:   {}".format(money(args.assignment_fee)))
    if args.closing_costs:
        print("Closing/holding costs:   {}".format(money(args.closing_costs)))
    print("-" * 48)
    print("MAO (max offer to seller): {}".format(money(mao)))
    print("Suggested contract price:  {}  (offer at or below MAO)".format(money(mao)))
    print("Assignment spread to you:  {}".format(money(args.assignment_fee)))
    print("Est. buyer margin at ARV:  {} ({:.1f}% of ARV)".format(
        money(buyer_margin), buyer_margin_pct))
    print("-" * 48)
    if mao <= 0:
        print("WARNING: MAO <= 0 — no room at these inputs. Recheck ARV/repairs/fee.")
    elif buyer_margin_pct < 10:
        print("CAUTION: thin buyer margin (<10% of ARV) — deal may be hard to assign.")
    print("NOTE: Repairs are an estimate; contractor walk-through governs before close.")


if __name__ == "__main__":
    main()
