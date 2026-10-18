# Kingmaker's driver for TradingAgents (lib/trading-agents.mjs): one ticker, one date, this Mac's Ollama models, and
# one result line on stdout. Research only: TradingAgents rates, it never orders, and nothing here adds a broker.
# Run as: <venv>/bin/python -I trading-agents-driver.py '<request json>'
import json
import sys

MARK = "KINGMAKER_RESULT "


def emit(result):
    print(MARK + json.dumps(result, ensure_ascii=False), flush=True)


def main():
    req = json.loads(sys.argv[1])
    from tradingagents.default_config import build_default_config
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    # The environment Kingmaker set (results, cache and memory under its own data folder; OLLAMA_BASE_URL) is read
    # here, then the brain is pinned to the local models whatever any TRADINGAGENTS_* variable says.
    config = build_default_config()
    config.update({
        "llm_provider": "ollama",
        "quick_think_provider": None, "deep_think_provider": None,
        "quick_think_backend_url": None, "deep_think_backend_url": None, "backend_url": None,
        "quick_think_llm": req["model"],
        "deep_think_llm": req["deepModel"],
        "max_debate_rounds": int(req["rounds"]),
        "max_risk_discuss_rounds": int(req["rounds"]),
        "output_language": req.get("language") or "English",
        "checkpoint_enabled": False,
    })
    print(f"TradingAgents desk: {req['ticker']} as of {req['date']} with {', '.join(req['analysts'])} on {req['model']}", flush=True)
    ta = TradingAgentsGraph(selected_analysts=req["analysts"], config=config)
    state, rating = ta.propagate(req["ticker"], req["date"], asset_type=req["assetType"])
    report_dir = ta.save_reports(state, req["ticker"])
    reports = {k: state.get(k) or "" for k in ("market_report", "sentiment_report", "news_report", "fundamentals_report",
                                               "investment_plan", "trader_investment_plan")}
    emit({"ok": True, "ticker": req["ticker"], "date": req["date"], "rating": str(rating),
          "decision": state.get("final_trade_decision") or "", "reports": reports, "reportDir": str(report_dir)})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # the one line Kingmaker reads either way
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:600]})
        sys.exit(1)
