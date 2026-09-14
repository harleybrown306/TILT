"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  resolveRecipientIds,
  type AssignmentAthlete,
  type AssignmentGroup,
  type AssignmentPlan,
  type AssignmentState,
} from "@/lib/training-assignment";
import { assignTraining } from "./actions";

const initialState: AssignmentState = { status: "idle", message: "" };

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export default function AssignmentForm({ teamId, plans, groups, athletes, defaultStartDate }: {
  teamId: string;
  plans: AssignmentPlan[];
  groups: AssignmentGroup[];
  athletes: AssignmentAthlete[];
  defaultStartDate: string;
}) {
  const [individualIds, setIndividualIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [planId, setPlanId] = useState("");
  const [state, formAction, pending] = useActionState(assignTraining.bind(null, teamId), initialState);
  const recipientIds = resolveRecipientIds(
    individualIds,
    groups.filter((group) => groupIds.includes(group.id)).flatMap((group) => group.athleteIds),
    athletes.map((athlete) => athlete.id),
  );
  const recipients = athletes.filter((athlete) => recipientIds.includes(athlete.id));
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const inputClass = "w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500";

  if (state.status === "success") {
    return <section role="status" className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-8">
      <h2 className="text-2xl font-semibold text-emerald-400">Training assigned</h2>
      <p className="mt-3 text-slate-200">{state.message}</p>
      <div className="mt-6 flex flex-wrap gap-4">
        <Link href={`/teams/${teamId}`} className="rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950">Back to team dashboard</Link>
        {/* A fresh page creates a new assignment action rather than resubmitting this one. */}
        <a href={`/teams/${teamId}/assign`} className="rounded-xl border border-slate-700 px-5 py-3 font-semibold">Assign another plan</a>
      </div>
    </section>;
  }

  return (
    <form action={formAction} className="space-y-6">
      {state.message && <div role="alert" className="rounded-2xl border border-rose-900 bg-rose-950/30 p-5 text-rose-300">{state.message}</div>}
      <fieldset disabled={pending || state.status === "review_required"} className="space-y-6 disabled:opacity-70">
        <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div>
            <label htmlFor="training-plan" className="mb-2 block font-medium">Training plan</label>
            {plans.length === 0 ? <p className="text-slate-400">No active training plans are available for this team. A plan must be available before training can be assigned.</p> : <>
              <select id="training-plan" name="trainingPlanId" required value={planId} onChange={(event) => setPlanId(event.target.value)} className={inputClass}>
                <option value="">Select a training plan</option>
                {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
              </select>
              {selectedPlan?.description && <p className="mt-2 text-sm text-slate-400">{selectedPlan.description}</p>}
            </>}
          </div>
          <div>
            <label htmlFor="start-date" className="mb-2 block font-medium">Start date</label>
            <input id="start-date" name="startDate" type="date" required defaultValue={defaultStartDate} className={inputClass} />
            <p className="mt-2 text-sm text-slate-400">Training dates use America/Chicago.</p>
          </div>
          <div>
            <label htmlFor="assignment-notes" className="mb-2 block font-medium">Notes <span className="font-normal text-slate-400">(optional)</span></label>
            <textarea id="assignment-notes" name="notes" rows={3} className={inputClass} />
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-labelledby="groups-heading">
          <h2 id="groups-heading" className="text-2xl font-semibold">Groups</h2>
          <p className="mt-2 text-sm text-slate-400">Select any groups you want to include. Groups are optional.</p>
          {groups.length === 0 ? <p className="mt-5 text-slate-400">No groups have been created. You can still select individual athletes below.</p> : <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {groups.map((group) => <label key={group.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 p-4">
              <input type="checkbox" name="groupIds" value={group.id} checked={groupIds.includes(group.id)} onChange={() => setGroupIds(toggleId(groupIds, group.id))} className="mt-1 accent-emerald-500" />
              <span><span className="block font-semibold">{group.name}</span><span className="mt-1 block text-sm text-slate-400">{group.athleteIds.length} {group.athleteIds.length === 1 ? "athlete" : "athletes"}</span></span>
            </label>)}
          </div>}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-labelledby="athletes-heading">
          <h2 id="athletes-heading" className="text-2xl font-semibold">Athletes</h2>
          {athletes.length === 0 ? <p className="mt-5 text-slate-400">No athletes are on this team. Add athletes to the roster before assigning training.</p> : <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {athletes.map((athlete) => {
              const includedThroughGroup = groups.some((group) => groupIds.includes(group.id) && group.athleteIds.includes(athlete.id));
              return <label key={athlete.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-700 p-4">
                <input type="checkbox" name="athleteIds" value={athlete.id} checked={individualIds.includes(athlete.id)} onChange={() => setIndividualIds(toggleId(individualIds, athlete.id))} className="mt-1 accent-emerald-500" />
                <span><span className="block font-semibold">{athlete.name}</span>{includedThroughGroup && <span className="mt-1 block text-sm text-emerald-400">Included through a selected group</span>}</span>
              </label>;
            })}
          </div>}
        </section>

        <section className="rounded-2xl border border-emerald-500/30 bg-slate-900 p-6" aria-labelledby="recipient-heading">
          <h2 id="recipient-heading" className="text-2xl font-semibold" aria-live="polite">{recipients.length} unique {recipients.length === 1 ? "athlete" : "athletes"} will receive training</h2>
          <p className="mt-2 text-sm text-slate-400">Each athlete receives one assignment, even when selected individually and through multiple groups. Group membership is checked again when you submit.</p>
          {recipients.length > 0 ? <ul className="mt-4 flex flex-wrap gap-2" aria-label="Selected recipients">
            {recipients.map((athlete) => <li key={athlete.id} className="rounded-full bg-slate-800 px-3 py-1 text-sm">{athlete.name}</li>)}
          </ul> : <p className="mt-4 text-slate-400">Select athletes or a group containing athletes to continue.</p>}
          {!plans.length && <p role="status" className="mt-4 text-sm text-amber-300">
            Assignment is unavailable because this team has no active training plan. Draft and archived plans cannot be assigned.
          </p>}
          <button type="submit" disabled={!planId || !recipients.length || pending || state.status === "review_required"} className="mt-6 rounded-xl bg-emerald-500 px-6 py-3 font-bold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {pending ? "Assigning training…" : "Assign Training"}
          </button>
        </section>
      </fieldset>
    </form>
  );
}
