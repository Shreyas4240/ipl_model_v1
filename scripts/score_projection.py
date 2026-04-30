import json
from pathlib import Path


DEFAULT_RR_SHRINK = {
    "alpha_by_phase": [0.129668, 0.374227, 0.64401],
    "mu_by_phase": [7.916135, 8.506491, 8.66626],
}

DEFAULT_RESOURCE_MODEL = {
    "phases": [
        {"C": 35.183517, "b": 0.050941, "a_w": 0.010875},
        {"C": 29.6944, "b": 0.054326, "a_w": 0.003438},
        {"C": 45.666991, "b": 0.040952, "a_w": 0.00194},
    ],
    "wicket_gamma": 2.499963,
    "phase_blend_overs": 0.5,
}


def load_model_params(repo_root: Path):
    model_path = repo_root / "data" / "model_params.json"
    if not model_path.exists():
        return None
    try:
        with open(model_path) as f:
            return json.load(f)
    except Exception:
        return None


def powerplay_phase(overs_completed: float) -> int:
    if overs_completed <= 6:
        return 0
    if overs_completed <= 16:
        return 1
    return 2


def get_rr_shrink(model_params):
    s = (model_params or {}).get("rr_shrinkage", {})
    alpha = s.get("alpha_by_phase")
    mu = s.get("mu_by_phase")
    if isinstance(alpha, list) and len(alpha) == 3 and isinstance(mu, list) and len(mu) == 3:
        return [float(x) for x in alpha], [float(x) for x in mu]
    return DEFAULT_RR_SHRINK["alpha_by_phase"], DEFAULT_RR_SHRINK["mu_by_phase"]


def get_resource_model(model_params):
    rm = (model_params or {}).get("resource_model", {})
    phases = rm.get("phases")
    if isinstance(phases, list) and len(phases) == 3:
        return {
            "phases": phases,
            "wicket_gamma": float(rm.get("wicket_gamma", DEFAULT_RESOURCE_MODEL["wicket_gamma"])),
            "phase_blend_overs": float(rm.get("phase_blend_overs", DEFAULT_RESOURCE_MODEL["phase_blend_overs"])),
        }
    return DEFAULT_RESOURCE_MODEL


def effective_run_rate(run_rate: float, overs_completed: float, model_params) -> float:
    k = powerplay_phase(overs_completed)
    alpha_by_phase, mu_by_phase = get_rr_shrink(model_params)
    alpha = alpha_by_phase[k]
    mu = mu_by_phase[k]
    return alpha * float(run_rate) + (1 - alpha) * mu


def resource_for_phase(phase_idx: int, overs_remaining: float, wickets_remaining: int, model) -> float:
    p = model["phases"][phase_idx]
    C = float(p.get("C", 0.0))
    b = float(p.get("b", 0.0))
    a_w = float(p.get("a_w", 0.0))
    gamma = float(model.get("wicket_gamma", DEFAULT_RESOURCE_MODEL["wicket_gamma"]))
    wickets_lost = max(0, 10 - int(wickets_remaining))
    return C * (1 - pow(2.718281828459045, -b * max(0.0, overs_remaining))) * pow(
        2.718281828459045, -a_w * (wickets_lost ** gamma)
    )


def resource_factor(overs_remaining: float, wickets_remaining: int, overs_completed: float, model_params) -> float:
    model = get_resource_model(model_params)
    d = float(model.get("phase_blend_overs", 0.5))
    oc = float(overs_completed)

    if oc <= 6 - d:
        return resource_for_phase(0, overs_remaining, wickets_remaining, model)
    if 6 + d <= oc <= 16 - d:
        return resource_for_phase(1, overs_remaining, wickets_remaining, model)
    if oc >= 16 + d:
        return resource_for_phase(2, overs_remaining, wickets_remaining, model)

    if 6 - d < oc < 6 + d:
        t = (oc - (6 - d)) / (2 * d)
        r0 = resource_for_phase(0, overs_remaining, wickets_remaining, model)
        r1 = resource_for_phase(1, overs_remaining, wickets_remaining, model)
        return (1 - t) * r0 + t * r1

    t = (oc - (16 - d)) / (2 * d)
    r1 = resource_for_phase(1, overs_remaining, wickets_remaining, model)
    r2 = resource_for_phase(2, overs_remaining, wickets_remaining, model)
    return (1 - t) * r1 + t * r2


def project_final_score(
    current_score: float,
    run_rate: float,
    overs_remaining: float,
    wickets_lost: int,
    overs_completed: float,
    model_params,
) -> float:
    wickets_remaining = max(0, 10 - int(wickets_lost))
    rr_eff = effective_run_rate(run_rate, overs_completed, model_params)
    resource = resource_factor(overs_remaining, wickets_remaining, overs_completed, model_params)
    return float(current_score) + rr_eff * resource
