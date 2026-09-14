import { offsetToDayNumber, type PlanItem } from "@/lib/training-plans";

export const planInputClass = "w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white outline-none focus:border-emerald-500";

export default function ScheduleFields({ item, nextPosition = 0 }: { item?: PlanItem; nextPosition?: number }) {
  return <>
    <div className="grid gap-4 sm:grid-cols-3">
      <label className="block text-sm font-medium">Day number
        <input name="dayNumber" type="number" min="1" max="2147483647" step="1" required defaultValue={item ? offsetToDayNumber(item.day_offset) : 1} className={`${planInputClass} mt-2`} />
      </label>
      <label className="block text-sm font-medium">Order number
        <input name="orderNumber" type="number" min="1" max="2147483647" step="1" required defaultValue={item ? item.position + 1 : nextPosition + 1} className={`${planInputClass} mt-2`} />
      </label>
      <label className="block text-sm font-medium">Scheduled time (optional)
        <input name="scheduledTime" type="time" step="1" defaultValue={item?.scheduled_time ?? ""} className={`${planInputClass} mt-2`} />
      </label>
    </div>
    <label className="block text-sm font-medium">Workout notes (optional)
      <textarea name="notes" rows={2} defaultValue={item?.notes ?? ""} className={`${planInputClass} mt-2`} />
    </label>
  </>;
}
