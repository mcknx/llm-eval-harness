import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient } from "./triage.ts";
import { JUDGE_SYSTEM, type Case } from "./eval.ts";

export type Recording = Record<string, { output: string; judge: { pass: boolean; reason: string }; usage: [number, number] }>;

/**
 * Replays recorded model outputs so the eval runs offline and free in CI.
 * It answers the triage call and the judge call for whichever dataset case the request is about.
 */
export function replayClient(dataset: Case[], rec: Recording): ModelClient {
  return {
    messages: {
      async create(params) {
        const user = String(params.messages.at(-1)!.content);
        const c = dataset.find((d) => user.includes(d.ticket));
        if (!c || !rec[c.id]) throw new Error("no recording for this request");
        const isJudge = params.system === JUDGE_SYSTEM;
        const text = isJudge ? JSON.stringify(rec[c.id].judge) : rec[c.id].output;
        const [input_tokens, output_tokens] = isJudge ? [300, 40] : rec[c.id].usage;
        return {
          id: `msg_replay_${c.id}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens, output_tokens },
        } as unknown as Anthropic.Message;
      },
    },
  };
}
