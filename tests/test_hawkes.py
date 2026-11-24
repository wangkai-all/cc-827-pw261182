from __future__ import annotations

import random
import unittest

from app.hawkes import (
    ModelSpec,
    evaluate_holdout,
    fit_model,
    fit_poisson,
    initial_parameters,
    likelihood,
    pack_params,
    prepare_dataset,
    simulate_forecast_counts,
    synthetic_dataset,
    split_time_by_exposure,
    make_scope,
)
from app.service import event_inspection, events_payload, run_analysis


class GradientTests(unittest.TestCase):
    def _gradient_relative_errors(self, scenario: str, boundary: str, gap: bool, kernel_shape: str = "exp"):
        raw = synthetic_dataset(scenario, seed=5)
        data = prepare_dataset(raw)
        train = make_scope(data, hi=split_time_by_exposure(data, 0.7))
        model = ModelSpec(data["categories"], [], "pair", kernel_shape)
        pspec, maps = model.build_index()
        q = pack_params(initial_parameters(train, model), model, pspec, maps)
        rng = random.Random(2)
        q = [x + rng.uniform(-0.12, 0.12) for x in q]
        from app.hawkes import unpack_q

        params = unpack_q(q, model, pspec)
        out = likelihood(params, train, model, pspec, maps, boundary=boundary, gap_correction=gap, want_grad=True, max_rho=0.995)
        g = out["gradient"]
        worst = 0.0
        for idx in range(len(q)):
            eps = 1e-5
            qp, qm = q[:], q[:]
            qp[idx] += eps
            qm[idx] -= eps
            fp = likelihood(unpack_q(qp, model, pspec), train, model, pspec, maps, boundary=boundary, gap_correction=gap, want_grad=False, max_rho=0.995)["loglik"]
            fm = likelihood(unpack_q(qm, model, pspec), train, model, pspec, maps, boundary=boundary, gap_correction=gap, want_grad=False, max_rho=0.995)["loglik"]
            fd = (fp - fm) / (2 * eps)
            worst = max(worst, abs(fd - g[idx]) / max(1.0, abs(fd), abs(g[idx])))
        return worst

    def test_observed_gradient(self):
        self.assertLess(self._gradient_relative_errors("self_excitation", "observed", False), 1e-5)

    def test_stationary_gradient(self):
        self.assertLess(self._gradient_relative_errors("self_excitation", "stationary", False), 1e-5)

    def test_gap_relaxation_gradient(self):
        self.assertLess(self._gradient_relative_errors("observation_gaps", "stationary", True), 1e-5)

    def test_gamma2_gradients(self):
        self.assertLess(self._gradient_relative_errors("self_excitation", "stationary", False, "gamma2"), 1e-5)
        self.assertLess(self._gradient_relative_errors("observation_gaps", "stationary", True, "gamma2"), 1e-5)


class FittingTests(unittest.TestCase):
    def test_background_only_selects_poisson_and_low_trigger(self):
        raw = synthetic_dataset("background_only", seed=11)
        result = run_analysis(raw, {"maxIter": 70, "forecastPaths": 20})
        self.assertTrue(result["ok"])
        self.assertLess(result["fit"]["rho"], 0.25)
        self.assertLess(result["truth_score"]["false_trigger_mass"], 0.25)
        self.assertIn(result["fit"]["model_family"], {"poisson", "hawkes_exp"})

    def test_self_excitation_recovers_branching_matrix(self):
        raw = synthetic_dataset("self_excitation", seed=11)
        data = prepare_dataset(raw)
        train = make_scope(data, hi=split_time_by_exposure(data, 0.7))
        fit = fit_model(train, data["categories"], bg_bins=1, beta_mode="common", max_iter=160, random_restarts=1)
        self.assertLess(fit["rho"], 0.95)
        truth = raw["synthetic_truth"]["eta"]
        # Dominant diagonal links should be recovered to useful accuracy.
        self.assertLess(abs(fit["params"]["eta"][0][0] - truth[0][0]), 0.25)
        self.assertLess(abs(fit["params"]["eta"][1][1] - truth[1][1]), 0.28)

    def test_unstable_model_is_refused_forecast(self):
        refused = simulate_forecast_counts({"rho": 1.2}, 0, 10, [(0, 10)])
        self.assertFalse(refused["allowed"])
        self.assertIn("稳定性", refused["reason"])


class ServiceTests(unittest.TestCase):
    def test_analysis_and_event_inspection(self):
        raw = synthetic_dataset("observation_gaps", seed=11)
        result = run_analysis(raw, {"maxIter": 55, "forecastPaths": 15})
        self.assertTrue(result["ok"])
        self.assertTrue(result["forecast"]["future"]["allowed"])
        self.assertGreater(len(result["events"]), 0)
        idx = result["events"][min(8, len(result["events"]) - 1)]["index"]
        event = event_inspection(raw, {"fit": result["fit"], "eventIndex": idx, "topN": 6})
        self.assertEqual(event["event_index"], idx)
        self.assertGreater(event["lambda"], 0)
        self.assertAlmostEqual(event["background"] + event["trigger"], event["lambda"], places=5)


    def test_top_source_labels_use_stable_indices_with_outside_events(self):
        raw = {
            "categories": ["A"],
            "windows": [[10.0, 20.0]],
            "events": [{"t": 1.0, "category": "A"}]
            + [{"t": 10.0 + i * 0.7, "category": "A"} for i in range(1, 12)],
        }
        result = run_analysis(raw, {"maxIter": 3, "includeForecast": False})
        result["fit"]["eta"] = [[0.8]]
        idx = len(raw["events"]) - 1
        event = event_inspection(raw, {"fit": result["fit"], "eventIndex": idx, "topN": 3})
        self.assertEqual(event["event_index"], idx)
        self.assertTrue(event["top_sources"])
        self.assertEqual(event["top_sources"][0]["t"], 17.0)
        # Raw prepared index of t=17 is 10; scope-local index would be 9.
        self.assertEqual(event["top_sources"][0]["event_index"], 10)

    def test_selected_category_subset_still_scores_truth(self):
        raw = synthetic_dataset("self_excitation", seed=11)
        result = run_analysis(raw, {"selectedCategories": ["A"], "maxIter": 3, "forecastPaths": 2})
        self.assertTrue(result["ok"])
        self.assertEqual(result["fit"]["categories"], ["A"])
        self.assertIsNotNone(result["truth_score"])

    def test_event_inspection_rejects_fit_category_mismatch(self):
        raw = synthetic_dataset("self_excitation", seed=11)
        result = run_analysis(raw, {"maxIter": 3, "includeForecast": False})
        event_b = next(e for e in result["events"] if e["category"] == result["fit"]["categories"][1])
        with self.assertRaises(ValueError):
            event_inspection(
                raw,
                {
                    "fit": result["fit"],
                    "eventIndex": event_b["index"],
                    "selectedCategories": [result["fit"]["categories"][0]],
                },
            )

    def test_event_selector_sample_preserves_final_event(self):
        raw = {
            "categories": ["A"],
            "windows": [[0.0, 6000.0]],
            "events": [{"t": i + 0.5, "category": "A"} for i in range(6000)],
        }
        data = prepare_dataset(raw)
        payload = events_payload(data, 2500)
        self.assertLessEqual(len(payload), 2500)
        self.assertEqual(payload[0]["index"], 0)
        self.assertEqual(payload[-1]["index"], 5999)


class WindowTests(unittest.TestCase):
    def test_closed_endpoint_enters_likelihood_and_diagnostics(self):
        raw = {
            "events": [
                {"t": 0.0, "category": "A"},
                {"t": 1.0, "category": "A"},
                {"t": 2.0, "category": "B"},
            ],
            "windows": [[0.0, 2.0]],
        }
        data = prepare_dataset(raw)
        self.assertTrue(all(e["in_window"] for e in data["events"]))
        scope = make_scope(data)
        self.assertEqual([e["t"] for e in scope["events"]], [0.0, 1.0, 2.0])

        fit = fit_poisson(scope, data["categories"], bg_bins=1)
        out = likelihood(
            fit["params"],
            scope,
            fit["spec"],
            fit["pspec"],
            fit["maps"],
            want_grad=False,
            return_trace=True,
        )
        self.assertEqual([r["t"] for r in out["event_rows"]], [0.0, 1.0, 2.0])

        evaluation = evaluate_holdout(fit, scope)
        self.assertEqual(len(evaluation["rows"]), 3)
        self.assertEqual(evaluation["counts"]["total_observed"], 3)

    def test_explicit_split_event_is_not_double_counted(self):
        raw = {
            "events": [
                {"t": 4.0, "category": "A"},
                {"t": 5.0, "category": "A"},
                {"t": 6.0, "category": "A"},
            ],
            "windows": [[0.0, 10.0]],
        }
        data = prepare_dataset(raw)
        split = split_time_by_exposure(data, 0.5)
        self.assertEqual(split, 5.0)
        train = make_scope(data, hi=split)
        holdout = make_scope(data, lo=split)
        self.assertEqual([e["t"] for e in train["events"]], [4.0, 5.0])
        self.assertEqual([e["t"] for e in holdout["events"]], [6.0])

    def test_holdout_relaxes_gap_from_training_end_to_first_window(self):
        raw = synthetic_dataset("observation_gaps", seed=11)
        data = prepare_dataset(raw)
        split = split_time_by_exposure(data, 0.7)
        train = make_scope(data, hi=split)
        holdout = make_scope(data, lo=split)
        self.assertEqual(split, 82.0)
        self.assertEqual(train["windows"][-1][1], 82.0)
        self.assertEqual(holdout["windows"][0][0], 86.0)

        fit = fit_model(
            train,
            data["categories"],
            bg_bins=1,
            beta_mode="common",
            max_iter=25,
            random_restarts=1,
        )
        corrected = evaluate_holdout(fit, holdout, initial_time=split)
        # Simulate the old assumption that final_state is already at the first
        # holdout-window boundary despite the four-unit gap.
        skipped_initial_gap = evaluate_holdout({**fit, "final_state_time": None}, holdout)
        self.assertNotAlmostEqual(corrected["loglik"], skipped_initial_gap["loglik"], places=4)

    def test_gap_and_window_summary(self):
        raw = synthetic_dataset("observation_gaps", seed=8)
        data = prepare_dataset(raw)
        self.assertGreaterEqual(len(data["windows"]), 8)
        self.assertGreater(len(data["gaps"]), 0)
        self.assertLess(data["coverage"], 0.8)

    def test_rounded_dataset_reports_resolution(self):
        raw = synthetic_dataset("rounded_batches", seed=4)
        data = prepare_dataset(raw)
        self.assertEqual(data["resolution"], 1.0)
        self.assertGreater(data["rounding"]["tie_rate"], 0.05)


if __name__ == "__main__":
    unittest.main()
