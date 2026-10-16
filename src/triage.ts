import type Anthropic from "@anthropic-ai/sdk";

/** Only the slice of the SDK client we use, so a recorded/fake client can stand in. */
export type ModelClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

export type Triage = { category: "billing" | "shipping" | "technical" | "account" | "other"; priority: "low" | "normal" | "urgent"; order_id: string | null; reply: string };

export const MODEL = "claude-opus-5-5";

// The feature under test. Change this prompt, then run the eval to see if it got better or worse.
export const TRIAGE_SYSTEM = `You triage customer-support tickets for an online shop.
- category: billing (charges, refunds, invoices, discounts), shipping (delivery, tracking, returns, cancelling an order), technical (bugs, errors, outages), account (login, security, data), other.
- priority: urgent if money is badly wrong, the customer is locked out or hacked, production is down, or a delay causes real harm; low for general questions; otherwise normal.
- order_id: the order number exactly as written without '#', or null.
- reply: a short, polite first reply. Never promise refunds, amounts or dates.`;

const SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["billing", "shipping", "technical", "account", "other"] },
    priority: { type: "string", enum: ["low", "normal", "urgent"] },
    order_id: { type: ["string", "null"] },
    reply: { type: "string" },
  },
  required: ["category", "priority", "order_id", "reply"],
  additionalProperties: false,
};

export async function triage(client: ModelClient, ticket: string): Promise<{ result: Triage | null; raw: string; usage: Anthropic.Usage }> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: TRIAGE_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Ticket:\n${ticket}` }],
  });
  const raw = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let result: Triage | null = null;
  try {
    result = JSON.parse(raw);
  } catch {
    // unparseable output is a failed case, not a crashed eval
  }
  return { result, raw, usage: res.usage };
}
