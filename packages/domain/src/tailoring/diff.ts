export interface DiffPart {
  op: "eq" | "del" | "ins";
  text: string;
}

/** Word-level diff (LCS) for showing how a bullet differs from its source fact. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter(Boolean).slice(0, 400);
  const b = after.split(/(\s+)/).filter(Boolean).slice(0, 400);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] =
        a[i] === b[j]
          ? (dp[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    const last = out.at(-1);
    if (last?.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("eq", a[i] ?? "");
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) push("del", a[i++] ?? "");
    else push("ins", b[j++] ?? "");
  }
  while (i < a.length) push("del", a[i++] ?? "");
  while (j < b.length) push("ins", b[j++] ?? "");
  return out;
}
