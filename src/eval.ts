import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, triage, type ModelClient, type Triage } from "./triage.ts";

export type Case = { id: string; ticket: string; expect: Pick<Triage, "category" | "priority" | "order_id"> };
export type CaseResult = { id: string; pass: boolean; critical: boolean; checks: Record<string, boolean>; note: string };
export type Report = { model: string; cases: number; passed: number; passRate: number; fieldAccuracy: Record<string, number>; usd: number; failures: CaseResult[] };
export type Baseline = { passRate: number; tolerance: number };

export const JUDGE_SYSTEM = `You grade a customer-support reply against a rubric. Pass only if ALL hold:
1. polite and on-topic for the ticket; 2. does not promise refunds, amounts or dates; 3. under 80 words.
Answer as JSON: {"pass": boolean, "reason": string}.`;

const JUDGE_SCHEMA = { type: "object", properties: { pass: { type: "boolean" }, reason: { type: "string" } }, required: ["pass", "reason"], additionalProperties: false };

// USD per 1M tokens, claude-opus-5-5.
const usd = (u: Anthropic.Usage) => (u.input_tokens * 4 + u.output_tokens * 20) / 1e6;

/** LLM-as-judge for the free-text part, which exact-match checks cannot grade. */
async function judge(client: ModelClient, ticket: string, reply: string) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: JUDGE_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
    messages: [{ role: "user", content: `Ticket:\n${ticket}\n\nReply:\n${reply}` }],
  });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { ...(JSON.parse(text) as { pass: boolean; reason: string }), usage: res.usage };
  } catch {
    return { pass: false, reason: "judge returned invalid JSON", usage: res.usage };
  }
}

export async function runEval(client: ModelClient, dataset: Case[]): Promise<Report> {
  let cost = 0;
  const results: CaseResult[] = [];
  for (const c of dataset) {
    const t = await triage(client, c.ticket);
    cost += usd(t.usage);
    if (!t.result) {
      results.push({ id: c.id, pass: false, critical: c.expect.priority === "urgent", checks: { json: false }, note: `not JSON: ${t.raw.slice(0, 60)}` });
      continue;
    }
    const j = await judge(client, c.ticket, t.result.reply);
    cost += usd(j.usage);
    const checks = {
      json: true,
      category: t.result.category === c.expect.category,
      priority: t.result.priority === c.expect.priority,
      order_id: t.result.order_id === c.expect.order_id,
      reply: j.pass,
    };
    const pass = Object.values(checks).every(Boolean);
    // Missing an urgent ticket is the failure that hurts customers: it fails the gate on its own.
    const critical = c.expect.priority === "urgent" && t.result.priority !== "urgent";
    const note = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => (k === "reply" ? `reply: ${j.reason}` : `${k}: got ${JSON.stringify(t.result![k as keyof Triage])}`)).join("; ");
    results.push({ id: c.id, pass, critical, checks, note });
  }
  const fields = ["json", "category", "priority", "order_id", "reply"];
  const passed = results.filter((r) => r.pass).length;
  return {
    model: MODEL,
    cases: results.length,
    passed,
    passRate: passed / results.length,
    fieldAccuracy: Object.fromEntries(fields.map((f) => [f, results.filter((r) => r.checks[f] ?? false).length / results.length])),
    usd: cost,
    failures: results.filter((r) => !r.pass),
  };
}

/** The CI gate: fail on a pass-rate drop beyond tolerance, or on any critical miss. */
export function gate(report: Report, baseline: Baseline): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const floor = baseline.passRate - baseline.tolerance;
  if (report.passRate < floor) reasons.push(`pass rate ${pct(report.passRate)} is below ${pct(floor)} (baseline ${pct(baseline.passRate)} - ${pct(baseline.tolerance)})`);
  for (const f of report.failures.filter((f) => f.critical)) reasons.push(`critical: ${f.id} is urgent but was not flagged urgent`);
  return { ok: reasons.length === 0, reasons };
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Markdown summary for the terminal and the GitHub Actions job summary. */
export function summary(r: Report, g: { ok: boolean; reasons: string[] }, label: string): string {
  return [
    `## Eval: ${label} ${g.ok ? "PASS" : "FAIL"}`,
    "",
    `${r.passed}/${r.cases} cases passed (${pct(r.passRate)}) on ${r.model}, cost $${r.usd.toFixed(4)}`,
    "",
    "| field | accuracy |",
    "|---|---|",
    ...Object.entries(r.fieldAccuracy).map(([k, v]) => `| ${k} | ${pct(v)} |`),
    "",
    ...(r.failures.length ? ["Failed cases:", ...r.failures.map((f) => `- ${f.id}${f.critical ? " (critical)" : ""}: ${f.note}`), ""] : []),
    ...(g.ok ? [] : ["Gate:", ...g.reasons.map((x) => `- ${x}`)]),
  ].join("\n");
}
