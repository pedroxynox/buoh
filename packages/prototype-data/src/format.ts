const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Fecha y hora en UTC, sin depender de la zona ni del idioma del equipo. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return `${String(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

/** Solo la hora, en UTC. */
export function formatUtcTime(iso: string): string {
  return formatUtc(iso).split(', ')[1] ?? iso;
}
