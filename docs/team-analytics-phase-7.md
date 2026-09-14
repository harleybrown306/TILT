# Team analytics

`/teams/[teamId]/analytics` uses the existing coach, assistant-coach, and platform-admin team authorization loader. Every query is filtered to the selected `team_id`; an athlete who belongs to several teams contributes only their selected-team sessions.

The 7- and 30-day windows are rolling America/Chicago scheduled-date windows ending today. **Prescribed Minutes** aggregate completed `training_session_prescriptions.prescribed_work_ms` and round after aggregation for display. They are not measured physical activity. A missing prescription still counts as a completed workout but contributes no minutes.

Attendance uses the existing aggregate Phase 5 denominator: past sessions and completed-today sessions, excluding future, pending-today, and cancelled sessions. Team attendance is completed expected sessions divided by expected sessions, never an average of athlete percentages. `N/A` means no expected sessions.

An active athlete has at least one completed team session in the selected window. Needs follow-up lists athletes with at least one missed expected session and makes no claim about effort, engagement, or telemetry. Raw events, measured-time summaries, exercise adherence, and shareable reports remain unavailable until reviewed server-side attempt summaries exist.
