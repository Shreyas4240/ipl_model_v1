import json
import random
from datetime import datetime
from pathlib import Path

import matplotlib.pyplot as plt


OUTCOMES = ["W", "0", "1", "2", "3", "4", "6"]
ILLEGAL_EXTRAS = {"wides", "noballs"}


def overs_to_balls(over_no, ball_in_over):
    return over_no * 6 + ball_in_over


def phase_from_ball(ball):
    over = (ball - 1) // 6
    if over < 6:
        return "pp"
    if over < 15:
        return "mid"
    return "death"


def rrr_bucket(rrr):
    if rrr < 6:
        return "lt6"
    if rrr < 8:
        return "6_8"
    if rrr < 10:
        return "8_10"
    if rrr < 12:
        return "10_12"
    return "ge12"


def balls_bucket(balls_remaining):
    if balls_remaining > 90:
        return "91_120"
    if balls_remaining > 60:
        return "61_90"
    if balls_remaining > 30:
        return "31_60"
    return "1_30"


def make_key(legal_balls_bowled, wickets, runs_needed, balls_remaining):
    nxt = legal_balls_bowled + 1
    phase = phase_from_ball(nxt)
    rrr = (runs_needed / balls_remaining) * 6 if balls_remaining > 0 else 99
    return f"{phase}|{min(10,max(0,wickets))}|{rrr_bucket(rrr)}|{balls_bucket(balls_remaining)}"


def sample_outcome(probs):
    u = random.random()
    c = 0
    for o in OUTCOMES:
        c += probs.get(o, 0.0)
        if u <= c:
            return o
    return "0"


def simulate_prob(model, runs, wickets, target, legal_balls_bowled, sims=4000):
    if target - runs <= 0:
        return 1.0
    if legal_balls_bowled >= 120 or wickets >= 10:
        return 0.0
    wins = 0
    for _ in range(sims):
        r = runs
        w = wickets
        b = legal_balls_bowled
        while b < 120 and w < 10 and r < target:
            balls_remaining = 120 - b
            runs_needed = max(0, target - r)
            key = make_key(b, w, runs_needed, balls_remaining)
            row = model["table"].get(key)
            probs = row["probs"] if row and row.get("n", 0) >= 15 else model["global_probs"]
            out = sample_outcome(probs)
            if out == "W":
                w += 1
            else:
                r += int(out)
            b += 1
        if r >= target:
            wins += 1
    return wins / sims


def is_legal(delivery):
    extras = delivery.get("extras", {})
    return not any(k in extras for k in ILLEGAL_EXTRAS)


def latest_match(path):
    latest = None
    latest_file = None
    latest_match = None
    for fp in path.glob("*.json"):
        try:
            m = json.loads(fp.read_text())
            if m.get("info", {}).get("match_type") != "T20" or len(m.get("innings", [])) < 2:
                continue
            d = datetime.fromisoformat((m["info"].get("dates") or ["1900-01-01"])[0])
            if latest is None or d > latest:
                latest = d
                latest_file = fp
                latest_match = m
        except Exception:
            continue
    return latest_file, latest_match


def main():
    root = Path(__file__).resolve().parents[1]
    model = json.loads((root / "data" / "winprob_sim_model.json").read_text())
    fp, match = latest_match(root / "ipl_male_json")
    info = match["info"]
    inn1, inn2 = match["innings"][0], match["innings"][1]

    first_total = sum(d["runs"]["total"] for o in inn1.get("overs", []) for d in o.get("deliveries", []))
    target = first_total + 1
    chasing_team = inn2.get("team", "")
    winner = (info.get("outcome") or {}).get("winner", "")

    balls = []
    probs = []
    runs = wickets = legal_balls = 0
    for over in inn2.get("overs", []):
        over_no = int(over.get("over", 0))
        for d in over.get("deliveries", []):
            runs += d["runs"]["total"]
            wickets += len(d.get("wickets", []))
            if not is_legal(d):
                continue
            ball_in_over = (legal_balls % 6) + 1
            p = simulate_prob(model, runs, wickets, target, legal_balls, sims=3500)
            legal_balls += 1
            balls.append(overs_to_balls(over_no, ball_in_over))
            probs.append(p * 100)
            if runs >= target:
                break
        if runs >= target:
            break

    plt.figure(figsize=(12, 6))
    plt.plot(balls, probs, color="#1d4ed8", linewidth=2, label="Simulator win probability (chasing %)")
    plt.axhline(50, color="gray", linestyle="--", linewidth=1, alpha=0.6)
    plt.ylim(0, 100)
    plt.xlim(1, max(balls) if balls else 120)
    plt.title(
        f"Simulator Win Probability Ball-by-Ball: {inn1.get('team')} vs {inn2.get('team')}\\n"
        f"{fp.name} | Target: {target} | Chasing won: {winner == chasing_team}",
        fontsize=11,
    )
    plt.xlabel("Legal ball in chase")
    plt.ylabel("Chasing team win probability (%)")
    plt.legend(loc="lower right")
    plt.tight_layout()
    out = root / "models" / "latest_match_simulator_winprob_curve.png"
    plt.savefig(out, dpi=180)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
