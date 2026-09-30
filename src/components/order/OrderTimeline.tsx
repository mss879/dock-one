import { formatOrderDate, type OrderTimelineEntry } from "@/lib/orders";

/** The append-only order_tracking timeline, newest first (the SQL returns oldest first). */
export function OrderTimeline({ entries }: { entries: OrderTimelineEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-ink-2">No updates yet.</p>;
  const newestFirst = [...entries].reverse();
  return (
    <ol className="relative space-y-5 border-l border-line pl-5">
      {newestFirst.map((entry, i) => (
        <li key={`${entry.at ?? ""}-${i}`} className="relative">
          <span aria-hidden className={`absolute top-1.5 -left-[25px] size-2.5 border ${i === 0 ? "border-ink bg-lime" : "border-ink/40 bg-surface"}`} />
          <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <span className="font-semibold">{entry.status}</span>
            {entry.at && (
              <time dateTime={entry.at} className="label text-mute">
                {formatOrderDate(entry.at)}
              </time>
            )}
          </p>
          {entry.description && <p className="mt-0.5 text-sm text-ink-2">{entry.description}</p>}
          {entry.location && <p className="label mt-0.5 text-mute">{entry.location}</p>}
        </li>
      ))}
    </ol>
  );
}
