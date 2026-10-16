import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runEval, gate, type Case } from "../src/eval.ts";
import { replayClient } from "../src/replay-client.ts";

const dataset: Case[] = JSON.parse(fs.readFileSync("evals/dataset.json", "utf8"));
const baseline = JSON.parse(fs.readFileSync("evals/baseline-score.json", "utf8"));
const replay = (name: string) => replayClient(dataset, JSON.parse(fs.readFileSync(`evals/recordings/${name}.json`, "utf8")));

test("baseline recording: 19/20 pass and the gate is green", async () => {
  const r = await runEval(replay("baseline"), dataset);
  assert.equal(r.passed, 19);
  assert.deepEqual(r.failures.map((f) => f.id), ["t15"]);
  assert.deepEqual(gate(r, baseline), { ok: true, reasons: [] });
});

test("regressed recording: the gate fails and names every broken case", async () => {
  const r = await runEval(replay("regressed"), dataset);
  assert.equal(r.passed, 14);
  assert.deepEqual(r.failures.map((f) => f.id).sort(), ["t04", "t08", "t10", "t12", "t14", "t15"]);
  const g = gate(r, baseline);
  assert.equal(g.ok, false);
  assert.match(g.reasons[0], /pass rate 70% is below 90%/);
  assert.ok(g.reasons.includes("critical: t04 is urgent but was not flagged urgent"));
  assert.ok(g.reasons.includes("critical: t14 is urgent but was not flagged urgent"));
});

test("each grader catches its own kind of failure", async () => {
  const r = await runEval(replay("regressed"), dataset);
  const f = Object.fromEntries(r.failures.map((x) => [x.id, x]));
  assert.equal(f.t12.checks.json, false, "non-JSON output is a failed case, not a crash");
  assert.equal(f.t08.checks.order_id, false);
  assert.match(f.t08.note, /order_id: got "0988"/);
  assert.equal(f.t10.checks.reply, false, "the LLM judge rejects a reply that promises a refund");
  assert.equal(f.t10.checks.category, true);
});

test("a single critical miss fails the gate even when the pass rate is fine", () => {
  const report = { model: "m", cases: 20, passed: 19, passRate: 0.95, fieldAccuracy: {}, usd: 0, failures: [{ id: "t04", pass: false, critical: true, checks: {}, note: "" }] };
  assert.equal(gate(report, baseline).ok, false);
});

test("cost is summed from usage on every triage and judge call", async () => {
  const r = await runEval(replay("baseline"), dataset);
  // triage usage from the recording + 20 judge calls at 300 in / 40 out, priced at $4 / $20 per 1M
  const rec = JSON.parse(fs.readFileSync("evals/recordings/baseline.json", "utf8"));
  const triageUsd = Object.values(rec).reduce((s: number, x: any) => s + (x.usage[0] * 4 + x.usage[1] * 20) / 1e6, 0);
  assert.equal(r.usd.toFixed(6), (triageUsd + 20 * (300 * 4 + 40 * 20) / 1e6).toFixed(6));
});
