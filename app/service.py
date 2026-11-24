"""JSON-safe application service layer around the Hawkes core."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence

from .hawkes import (
    ModelSpec,
    evaluate_holdout,
    event_contributions,
    fit_candidate_set,
    intensity_series,
    make_scope,
    parameter_recovery_score,
    prepare_dataset,
    simulate_forecast_counts,
    split_time_by_exposure,
    synthetic_dataset,
)


def _round(x: Any, n: int = 6) -> Any:
    if isinstance(x, (int, float)) and x is not None and math.isfinite(float(x)):
        return round(float(x), n)
    return x


def matrix_to_json(a: Sequence[Sequence[float]], digits: int = 6) -> List[List[float]]:
    return [[_round(x, digits) for x in row] for row in a]


def fit_to_json(fit: Dict[str, Any]) -> Dict[str, Any]:
    p = fit["params"]
    return {
        "model_family": fit.get("model_family", "hawkes_exp"),
        "categories": fit["categories"],
        "mu": matrix_to_json(p["mu"]),
        "eta": matrix_to_json(p["eta"]),
        "beta": matrix_to_json(p["beta"]),
        "rho": _round(fit["rho"]),
        "stable": bool(fit["stable"]),
        "stationary_forecast_allowed": bool(fit.get("stationary_forecast_allowed", fit["rho"] < 0.999)),
        "loglik": _round(fit["loglik"], 4),
        "aic": _round(fit["aic"], 3),
        "bic": _round(fit["bic"], 3),
        "n_params": fit["n_params"],
        "n_events": fit["n_events"],
        "boundary": fit.get("boundary"),
        "gap_correction": fit.get("gap_correction"),
        "beta_mode": fit.get("beta_mode"),
        "kernel_shape": fit.get("kernel_shape", "exp"),
        "bg_bins": fit.get("bg_bins"),
        "cuts": [_round(x, 5) for x in fit.get("cuts", [])],
        "final_state": [_round(x, 8) for x in fit.get("final_state", [])],
    }


def fit_from_json(payload: Dict[str, Any]) -> Dict[str, Any]:
    cats = list(payload["categories"])
    beta_mode = payload.get("beta_mode") or "pair"
    if beta_mode == "none":
        beta_mode = "common"
    kernel_shape = payload.get("kernel_shape") or "exp"
    if kernel_shape not in ("exp", "gamma2"):
        kernel_shape = "exp"
    cuts = [float(x) for x in payload.get("cuts", [])]
    spec = ModelSpec(cats, cuts, beta_mode if beta_mode in ("pair", "common") else "pair", kernel_shape)
    pspec, maps = spec.build_index()
    # Versions saved before the positive Poisson floor could contain mu=0.
    # Floor only background rates so inspecting a previously unseen holdout
    # event returns a finite attribution response.
    mu = [[max(1e-8, float(x)) for x in row] for row in payload["mu"]]
    params = {"mu": mu, "eta": payload["eta"], "beta": payload["beta"]}
    return {
        "params": params,
        "spec": spec,
        "pspec": pspec,
        "maps": maps,
        "categories": cats,
        "rho": float(payload.get("rho", 0.0)),
        "final_state": payload.get("final_state"),
        "gap_correction": payload.get("gap_correction", True),
    }


def dataset_summary(data: Dict[str, Any]) -> Dict[str, Any]:
    counts = {c: 0 for c in data["categories"]}
    for e in data["events"]:
        counts[e["category"]] += 1
    outside = [e for e in data["events"] if not e.get("in_window", True)]
    return {
        "name": data.get("name"),
        "description": data.get("description"),
        "categories": data["categories"],
        "category_counts": counts,
        "n_events": len(data["events"]),
        "n_windows": len(data["windows"]),
        "windows": [[_round(a, 5), _round(b, 5)] for a, b in data["windows"]],
        "gaps": [{"start": _round(a, 5), "end": _round(b, 5), "duration": _round(b - a, 5)} for a, b in data["gaps"]],
        "active_duration": _round(data["active_duration"], 4),
        "calendar_span": _round(data["calendar_span"], 4),
        "gap_duration": _round(data["gap_duration"], 4),
        "coverage": _round(data["coverage"], 4),
        "time_unit": data.get("time_unit"),
        "time_origin": data.get("time_origin"),
        "window_source": data.get("window_source"),
        "history_start": _round(data.get("history_start"), 5),
        "outside_event_count": len(outside),
        "resolution": _round(data.get("resolution"), 6),
        "rounding": {k: _round(v, 5) if isinstance(v, float) else v for k, v in data["rounding"].items()},
    }


def events_payload(data: Dict[str, Any], limit: Optional[int] = None) -> List[Dict[str, Any]]:
    # The inspector addresses prepared-data indices.  Restrict the selector to
    # events inside active windows; out-of-window imports are reported separately
    # and evaluating them at an arbitrary time would be misleading.
    evs = [e for e in data["events"] if e.get("in_window", True)]
    indexed = [(int(e.get("index", i)), e) for i, e in enumerate(evs)]
    if limit and len(indexed) > limit:
        # Deterministic near-uniform sample that explicitly retains both the
        # first and final imported in-window event.  Navigation moves by option
        # position because sampled stable indices can be sparse.
        n = len(indexed)
        m = max(2, int(limit))
        positions = sorted({int(i * (n - 1) / (m - 1) + 0.5) for i in range(m)})
        indexed = [indexed[p] for p in positions]
    return [{"index": i, "t": _round(e["t"], 6), "category": e["category"], "ci": e["ci"]} for i, e in indexed]


def resolution_assessment(data: Dict[str, Any], fit: Dict[str, Any]) -> Dict[str, Any]:
    res = data.get("resolution")
    beta = fit["params"]["beta"]
    k = len(data["categories"])
    products = []
    timescale_ratios = []
    for i in range(k):
        for j in range(k):
            b = float(beta[i][j])
            if res and res > 0:
                products.append(res * b)
                timescale_ratios.append((1.0 / b) / res)
    unresolved = sum(1 for x in products if x > 0.5)
    marginal = sum(1 for x in products if 0.15 <= x <= 0.5)
    median_ts_ratio = sorted(timescale_ratios)[len(timescale_ratios) // 2] if timescale_ratios else None
    tie_rate = data["rounding"]["tie_rate"]
    if not res:
        level = "unknown"
        title = "未检测到明确时间分辨率"
        detail = "请提供 resolution；否则无法判断快速触发核是否只是舍入假象。"
    elif unresolved > k * k * 0.25 or tie_rate > 0.12:
        level = "critical"
        title = "分辨率限制可能主导快速核"
        detail = "部分拟合衰减时间短于一个舍入单位，且存在成批并列时间；同戳事件的父子顺序不可识别。"
    elif marginal > 0 or tie_rate > 0.04 or (median_ts_ratio is not None and median_ts_ratio < 5):
        level = "warning"
        title = "时间分辨率足以估计主尺度，但短滞后归因不稳定"
        detail = "核时间常数仅为数个舍入单位；应比较共同衰减/更粗核版本，不应过度解释单次事件的首位父事件。"
    else:
        level = "ok"
        title = "分辨率与拟合核尺度相容"
        detail = "典型衰减尺度显著大于舍入单位；仍需报告并列时间比例。"
    return {
        "level": level,
        "title": title,
        "detail": detail,
        "resolution": res,
        "tie_rate": tie_rate,
        "max_resolution_beta": max(products) if products else None,
        "unresolved_links": unresolved,
        "marginal_links": marginal,
        "median_timescale_in_resolution_units": median_ts_ratio,
        "recommendation": "主分析不做静默随机解戳；可用确定性区间抖动做敏感性版本。" if level != "ok" else "可查看事件级贡献，但相关链接仍不是因果证据。",
    }


def _json_safe_holdout(h: Dict[str, Any]) -> Dict[str, Any]:
    rows = []
    for r in h.get("rows", []):
        rows.append(
            {
                "t": _round(r["t"], 5),
                "ci": r["ci"],
                "category": r["category"],
                "lambda": _round(r["lambda"], 6),
                "background": _round(r["background"], 6),
                "trigger": _round(r["trigger"], 6),
                "background_probability": _round(r["background_probability"], 4),
                "trigger_probability": _round(r["trigger_probability"], 4),
            }
        )
    rt = h["residual_tests"]
    rt_out = dict(rt)
    if "qq" in rt_out:
        rt_out["qq"] = [{"empirical": _round(x["empirical"], 5), "theoretical": _round(x["theoretical"], 5)} for x in rt_out["qq"]]
    if "acf" in rt_out:
        rt_out["acf"] = [{"lag": x["lag"], "acf": _round(x["acf"], 4), "threshold": _round(x["threshold"], 4)} for x in rt_out["acf"]]
    if "ks" in rt_out:
        rt_out["ks"] = {k: _round(v, 5) for k, v in rt_out["ks"].items()}
    if "ljung_box" in rt_out:
        rt_out["ljung_box"] = {k: _round(v, 5) for k, v in rt_out["ljung_box"].items()}
    if "mean" in rt_out:
        for key in ("mean", "variance", "mean_z_score"):
            if key in rt_out:
                rt_out[key] = _round(rt_out[key], 4)
    return {
        "loglik": _round(h["loglik"], 4),
        "events": h["events"],
        "loglik_per_event": _round(h["loglik_per_event"], 5),
        "rows": rows,
        "residual_rows": [
            {"t": _round(r.get("t"), 5), "ci": r.get("ci"), "residual": _round(r.get("residual"), 5) if r.get("residual") is not None else None}
            for r in h.get("residual_rows", [])
        ],
        "residuals": [_round(x, 5) for x in h["residuals"]],
        "residual_tests": rt_out,
        "counts": {
            **h["counts"],
            "chi_square": _round(h["counts"]["chi_square"], 4),
            "p_value": _round(h["counts"]["p_value"], 5),
            "total_expected": _round(h["counts"]["total_expected"], 3),
            "cells": [{**c, "expected": _round(c["expected"], 3)} for c in h["counts"]["cells"]],
            "by_category": [{**c, "expected": _round(c["expected"], 3), "z": _round(c["z"], 3)} for c in h["counts"]["by_category"]],
        },
    }


def run_analysis(raw_dataset: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    options = options or {}
    selected = options.get("selectedCategories")
    data = prepare_dataset(raw_dataset, selected)
    categories = data["categories"]
    train_frac = float(options.get("trainFrac", 0.7))
    train_frac = max(0.4, min(0.9, train_frac))
    split = split_time_by_exposure(data, train_frac)
    train = make_scope(data, hi=split)
    holdout = make_scope(data, lo=split)

    complexity = options.get("backgroundComplexity", "auto")
    kernel_complexity = options.get("kernelComplexity", "auto")
    boundary = options.get("boundary", "stationary")
    gap_correction = bool(options.get("gapCorrection", True))
    enforce_stable = bool(options.get("enforceStable", True))
    max_iter = int(options.get("maxIter", 180))

    candidate_bundle = fit_candidate_set(
        train,
        categories,
        {
            "background_complexity": complexity,
            "kernel_complexity": kernel_complexity,
            "kernel_shape": options.get("kernelShape", "auto"),
            "boundary": boundary,
            "gap_correction": gap_correction,
            "enforce_stable": enforce_stable,
            "max_iter": max_iter,
        },
    )
    fit = candidate_bundle["selected"]
    holdout_eval = evaluate_holdout(fit, holdout, initial_time=split)
    hold = _json_safe_holdout(holdout_eval)

    # Intensity chart over the full observed timeline, conditioned on imported
    # events.  This is a retrospective decomposition, not a forecast.
    full_scope = make_scope(data)
    trace_raw = intensity_series(fit, full_scope, points_per_window=90)
    trace = {
        "t": [_round(x, 5) for x in trace_raw["t"]],
        "total": [_round(x, 6) for x in trace_raw["total"]],
        "background": [[_round(x, 6) for x in row] for row in trace_raw["background"]],
        "triggered": [[_round(x, 6) for x in row] for row in trace_raw["triggered"]],
    }

    forecast = None
    if options.get("includeForecast", True):
        horizon = float(options.get("forecastHorizon", max(data["calendar_span"] * 0.15, 1.0)))
        fc_end = holdout["windows"][-1][1] + horizon if holdout["windows"] else data["windows"][-1][1] + horizon
        future_windows = [(data["windows"][-1][1], fc_end)]
        # For count calibration, also simulate the observed holdout interval.
        pred_hold = simulate_forecast_counts(
            fit,
            split,
            holdout["windows"][-1][1],
            holdout["windows"],
            n_paths=int(options.get("forecastPaths", 140)),
            seed=int(options.get("seed", 123)),
        )
        future = simulate_forecast_counts(
            fit,
            data["windows"][-1][1],
            fc_end,
            future_windows,
            n_paths=int(options.get("forecastPaths", 140)),
            seed=int(options.get("seed", 124)),
            # This is the state after conditioning through the holdout's final
            # active-window endpoint, which equals the imported record's end.
            initial_state=holdout_eval.get("final_state"),
        )
        forecast = {"holdout_predictive": _json_forecast(pred_hold), "future": _json_forecast(future), "horizon": horizon}

    candidates = []
    for c in candidate_bundle["candidates"]:
        j = fit_to_json(c)
        candidates.append(
            {
                "id": f"{j['model_family']}-bg{j['bg_bins']}-{j['beta_mode']}-{j.get('kernel_shape', 'exp')}-{len(candidates)}",
                "model_family": j["model_family"],
                "bg_bins": j["bg_bins"],
                "beta_mode": j["beta_mode"],
                "kernel_shape": j.get("kernel_shape", "exp"),
                "aic": j["aic"],
                "bic": j["bic"],
                "loglik": j["loglik"],
                "n_params": j["n_params"],
                "rho": j["rho"],
                "stable": j["stable"],
                "cuts": j["cuts"],
                "is_selected": c is fit,
            }
        )

    truth_score = None
    if raw_dataset.get("synthetic_truth"):
        truth_score = parameter_recovery_score(
            raw_dataset["synthetic_truth"],
            fit,
            data.get("all_categories") or raw_dataset.get("categories"),
        )
        truth_score = {k: (_round(v, 4) if isinstance(v, float) else v) for k, v in truth_score.items()}

    return {
        "ok": True,
        "version": "1.0.0",
        "dataset": dataset_summary(data),
        "events": events_payload(data, int(options.get("maxChartEvents", 2500))),
        "all_event_count": len(data["events"]),
        "split": _round(split, 5),
        "train_window_count": len(train["windows"]),
        "holdout_window_count": len(holdout["windows"]),
        "fit": fit_to_json(fit),
        "candidates": candidates,
        "candidate_errors": candidate_bundle["errors"],
        "holdout": hold,
        "trace": trace,
        "resolution_assessment": resolution_assessment(data, fit),
        "boundary_diagnostics": boundary_diagnostics(data, fit, boundary, gap_correction),
        "forecast": forecast,
        "truth_score": truth_score,
        "disclaimer": "触发核表示时间条件强度上的统计预测贡献；链接/矩阵不是因果效应，不能据此断言某事件导致另一事件。",
    }


def _json_forecast(fc: Dict[str, Any]) -> Dict[str, Any]:
    if not fc.get("allowed"):
        return {"allowed": False, "reason": fc.get("reason"), "rho": _round(fc.get("rho"), 4)}
    return {
        "allowed": True,
        "rho": _round(fc["rho"], 4),
        "n_paths": fc["n_paths"],
        "total": {k: _round(v, 3) for k, v in fc["total"].items()},
        "categories": [{k: _round(v, 3) for k, v in interval.items()} for interval in fc["categories"]],
    }


def boundary_diagnostics(data: Dict[str, Any], fit: Dict[str, Any], boundary: str, gap_correction: bool) -> Dict[str, Any]:
    beta = fit["params"]["beta"]
    k = len(data["categories"])
    betas = [beta[i][j] for i in range(k) for j in range(k) if beta[i][j] > 0]
    median_beta = sorted(betas)[len(betas) // 2] if betas else 1.0
    memory = 3.0 / median_beta
    first_window = data["windows"][0]
    edge_events = sum(1 for e in data["events"] if first_window[0] <= e["t"] <= first_window[0] + memory)
    gap_edge_events = 0
    for a, b in data["windows"][1:]:
        gap_edge_events += sum(1 for e in data["events"] if a <= e["t"] <= a + memory)
    return {
        "boundary_mode": boundary,
        "gap_correction": gap_correction,
        "left_boundary": "稳态平均强度校正" if boundary == "stationary" and fit["rho"] < 0.999 else ("已知起始历史条件化" if boundary == "warmup" else "零历史（朴素敏感性）"),
        "gap_rule": "已知事件状态跨缺口衰减，并用稳态一阶均值注入未记录事件的期望贡献" if gap_correction and fit["rho"] < 0.999 else "仅让已记录事件贡献跨缺口衰减；不注入缺口内未记录事件",
        "memory_time_3_over_beta": _round(memory, 4),
        "left_edge_events": edge_events,
        "post_gap_edge_events": gap_edge_events,
        "gap_count": len(data["gaps"]),
        "coverage": data["coverage"],
        "warning": "窗口外无记录不表示无事件；边界附近残差和事件归因应结合这些计数解读。",
    }


def event_inspection(raw_dataset: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    data = prepare_dataset(raw_dataset, payload.get("selectedCategories"))
    fit = fit_from_json(payload["fit"])
    if list(fit.get("categories", [])) != list(data["categories"]):
        raise ValueError("拟合模型的类别与当前选择类别不一致；请重新拟合并再检查事件。")
    idx = int(payload["eventIndex"])
    if idx < 0 or idx >= len(data["events"]):
        raise IndexError("eventIndex out of range")
    target_data_event = data["events"][idx]
    if not target_data_event.get("in_window", True):
        raise IndexError("eventIndex refers to an event outside the imported observation windows")
    scope = make_scope(data)
    scope_idx = next((i for i, e in enumerate(scope["events"]) if e.get("index") == idx), None)
    if scope_idx is None:
        raise IndexError("eventIndex is not inside the fitted observation scope")
    # make_scope creates copies but preserves the prepared stable index.
    result = event_contributions(fit, scope, scope_idx, top_n=int(payload.get("topN", 12)))
    result["event_index"] = idx
    result["t"] = _round(result["t"], 6)
    result["lambda"] = _round(result["lambda"], 6)
    result["background"] = _round(result["background"], 6)
    result["trigger"] = _round(result["trigger"], 6)
    result["background_share"] = _round(result["background_share"], 4)
    result["trigger_share"] = _round(result["trigger_share"], 4)
    result["unexplained_or_baseline"] = _round(result["unexplained_or_baseline"], 6)
    result["unobserved_history_or_gap_trigger"] = _round(result.get("unobserved_history_or_gap_trigger", 0.0), 6)
    result["source_totals"] = [
        {**x, "contribution": _round(x["contribution"], 6), "share": _round(x["share"], 4)} for x in result["source_totals"]
    ]
    result["top_sources"] = [
        {**x, "contribution": _round(x["contribution"], 7), "share_of_intensity": _round(x["share_of_intensity"], 5), "parent_probability": _round(x["parent_probability"], 5), "lag": _round(x["lag"], 5), "t": _round(x["t"], 6)}
        for x in result["top_sources"]
    ]
    return result


def make_synthetic(scenario: str, seed: int = 11) -> Dict[str, Any]:
    return synthetic_dataset(scenario, seed=seed)
