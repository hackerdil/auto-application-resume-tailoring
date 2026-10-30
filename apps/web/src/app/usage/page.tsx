"use client";

import { useCallback, useEffect, useState } from "react";
import { Status, type StatusState } from "@/components/Status";
import { api, errorText, type ProvidersResponse, type UsageResponse } from "@/lib/api";

const PROVIDER_NAME: Record<string, string> = { openai: "OpenAI", claude: "Claude" };
const MODE_TEXT: Record<string, string> = {
  openai: "OpenAI only",
  claude: "Claude only",
  hybrid: "OpenAI does the work; Claude reviews résumé claims and helps when OpenAI is unavailable",
  compare: "Same as hybrid for now",
  auto: "Whichever provider is healthy, OpenAI first",
};

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function UsagePage() {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<StatusState>({ kind: "idle" });

  const load = useCallback(async () => {
    const [p, u] = await Promise.all([
      api<ProvidersResponse>("GET", "/api/v1/system/providers"),
      api<UsageResponse>("GET", `/api/v1/system/usage?days=${days}`),
    ]);
    setProviders(p);
    setUsage(u);
  }, [days]);

  useEffect(() => {
    load().catch((e: unknown) => {
      setStatus({ kind: "error", text: errorText(e) });
    });
  }, [load]);

  const totals = (usage?.rows ?? []).reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      errors: t.errors + r.errors,
      cost: t.cost + r.costUsd,
      unpriced: t.unpriced + r.unpricedCalls,
    }),
    { calls: 0, errors: 0, cost: 0, unpriced: 0 },
  );

  return (
    <>
      <h1>AI providers &amp; usage</h1>
      <p className="lede">
        Which AI services Career Agent may use, whether they are working, and what they have cost.
        Everything except AI suggestions works without them.
      </p>
      <Status state={status} />

      <h2>Providers</h2>
      {providers && (
        <>
          <p>
            Mode: <strong>{providers.mode}</strong> — {MODE_TEXT[providers.mode] ?? ""}
          </p>
          <div className="row">
            {providers.providers.map((p) => (
              <section className="card" key={p.provider}>
                <h3>{PROVIDER_NAME[p.provider] ?? p.provider}</h3>
                <p>
                  <span className={`badge ${p.ok ? "" : "sensitive"}`}>
                    {!p.configured
                      ? "not set up"
                      : !p.ok
                        ? "unavailable"
                        : p.lastSuccessAt
                          ? "working"
                          : "set up, not used yet"}
                  </span>
                </p>
                {p.reason && <p className="hint">{p.reason}</p>}
                {p.lastSuccessAt && (
                  <p className="hint">Last success {new Date(p.lastSuccessAt).toLocaleString()}</p>
                )}
                {p.coolingDownUntil && (
                  <p className="hint">
                    Paused after repeated failures until{" "}
                    {new Date(p.coolingDownUntil).toLocaleTimeString()}
                  </p>
                )}
              </section>
            ))}
          </div>
          <p className="hint">
            Limits per run: OpenAI {usd(providers.limits.openaiMaxCostUsdPerRun)}, Claude{" "}
            {usd(providers.limits.claudeMaxCostUsdPerRun)}, at most{" "}
            {providers.limits.maxClaudeDelegationsPerRun} Claude delegation(s).{" "}
            {providers.limits.openaiPricingConfigured
              ? "OpenAI costs are computed from your configured prices."
              : "Set OPENAI_INPUT_USD_PER_MTOK and OPENAI_OUTPUT_USD_PER_MTOK to see OpenAI costs."}{" "}
            Claude costs are the SDK&apos;s estimate; with a subscription they count against your
            plan&apos;s limits rather than a bill.
          </p>
        </>
      )}

      <h2>Usage</h2>
      <label>
        Period{" "}
        <select
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
          }}
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={365}>Last year</option>
        </select>
      </label>
      {usage && usage.rows.length === 0 ? (
        <p className="empty">No AI calls in this period.</p>
      ) : (
        usage && (
          <>
            <p>
              {totals.calls} call(s), {totals.errors} failed, {usd(totals.cost)} known cost
              {totals.unpriced ? ` (+${totals.unpriced} call(s) without a price)` : ""}.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Task</th>
                  <th>Calls</th>
                  <th>Failed</th>
                  <th>Fallback</th>
                  <th>Delegated</th>
                  <th>Tokens in / out</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.map((r) => (
                  <tr key={`${r.provider}-${r.taskType}`}>
                    <td>{PROVIDER_NAME[r.provider] ?? r.provider}</td>
                    <td>{r.taskType.replaceAll("_", " ")}</td>
                    <td>{r.calls}</td>
                    <td>{r.errors}</td>
                    <td>{r.fallbacks}</td>
                    <td>{r.delegated}</td>
                    <td>
                      {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                    </td>
                    <td>
                      {usd(r.costUsd)}
                      {r.unpricedCalls ? ` (+${r.unpricedCalls} unpriced)` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}
    </>
  );
}
