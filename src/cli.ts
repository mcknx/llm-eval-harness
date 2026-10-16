import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { runEval, gate, summary, type Case, type Baseline } from "./eval.ts";
import { replayClient, type Recording } from "./replay-client.ts";

// npm run eval                      -> replay evals/recordings/baseline.json (offline, free)
// npm run eval -- regressed         -> replay another recording
// npm run eval -- live              -> call the real API (needs ANTHROPIC_API_KEY)
const which = process.argv[2] ?? "baseline";
const dataset: Case[] = JSON.parse(fs.readFileSync("evals/dataset.json", "utf8"));
const baseline: Baseline = JSON.parse(fs.readFileSync("evals/baseline-score.json", "utf8"));
const client =
  which === "live" ? new Anthropic() : replayClient(dataset, JSON.parse(fs.readFileSync(`evals/recordings/${which}.json`, "utf8")) as Recording);

const report = await runEval(client, dataset);
const g = gate(report, baseline);
const md = summary(report, g, which === "live" ? "live API" : `replay of recordings/${which}.json`);
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
process.exitCode = g.ok ? 0 : 1;
