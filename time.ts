// Parse --since / --until values: relative (7d, 24h, 30m) or ISO timestamps.
export function parseTimeArg(value: string, now = Date.now()): number {
  const rel = value.match(/^(\d+)([dhm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms =
      unit === "d" ? n * 86_400_000 : unit === "h" ? n * 3_600_000 : n * 60_000;
    return now - ms;
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;

  throw new Error(`Invalid time "${value}" — use 7d, 24h, 30m, or an ISO date`);
}
