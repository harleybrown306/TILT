# Athlete time-first dashboard

The dashboard presents durable prescription volume alongside canonical workout completion. It does not present timer telemetry or legacy `workout_results.active_minutes` as measured physical activity.

## Metrics

- **Weekly Prescribed Minutes**: completed sessions scheduled during the rolling seven America/Chicago calendar dates ending today. Aggregate `training_session_prescriptions.prescribed_work_ms` first, then round the aggregate to the nearest whole minute for display.
- **Monthly Prescribed Minutes**: the same source for completed sessions scheduled from the first day of the current America/Chicago calendar month through today.
- **Completed Workouts**: distinct canonically completed, non-future training sessions.
- **Training Days**: distinct America/Chicago scheduled dates with one or more completed sessions.
- **Current Training Streak**: consecutive training days ending today, or yesterday when today has no completion. It measures consistency, not schedule adherence.

Sessions without a prescription still count as completed workouts where appropriate, but contribute no minutes. `legacy_backfill` snapshots may contribute prescribed volume; none of these values are claimed to be measured physical activity. The chart uses the same completed prescribed-work source, grouped by scheduled date.

The dashboard combines the signed-in athlete's authorized sessions across teams. Every card includes team context, and distinct sessions remain distinct even when they share a date or workout.

Future work can add reviewed server-side attempt summaries for measured elapsed/work timer metrics, then separately introduce exercise adherence and shareable Training Resume reports.
