import { describe, expect, it } from "vitest";

import { AnthropicModelAdapter } from "../src/anthropic-model.js";

const integration = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

integration("AnthropicModelAdapter live integration", () => {
  it("returns a preserved transcript and usage from a real call", async () => {
    const adapter = new AnthropicModelAdapter({
      systemPrompt:
        "You are a terse assistant. Answer in a single short sentence.",
      maxTokens: 256,
    });

    const response = await adapter.invoke({
      messages: [{ role: "user", content: "Name the capital of France." }],
    });

    expect(["completed", "truncated", "refused"]).toContain(
      response.output.status,
    );
    expect(response.usage.attempts).toBeGreaterThanOrEqual(1);
    expect(response.transcript.entries[0]?.role).toBe("system");
    expect(response.transcript.entries.at(-1)?.raw).not.toBeNull();
  });
});
