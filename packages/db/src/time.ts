export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const toIso = (ms: number): string => new Date(ms).toISOString();
export const fromIso = (iso: string): number => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`invalid ISO timestamp: ${iso}`);
  return ms;
};
export const toIsoOrNull = (ms: number | null | undefined): string | null =>
  ms == null ? null : toIso(ms);
