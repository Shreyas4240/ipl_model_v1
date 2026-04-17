import ipl_service

r = ipl_service.get_recent_results(past_days=9999) 
# Wait, the interface usually uses past_days=30 but defaults to MIN_MATCH_DATE for minimum. Let's see what the interface says.
# If I just print the returned MAE:
print("Simulated MAE of 5 stage model:", r["summary"]["mae"], "runs over", r["summary"]["count"], "predictions")

