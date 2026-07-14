import type {
  Transcript,
  TranscriptBlock,
  TranscriptEntry,
  UsageTelemetry,
} from "@sema-evals/core";

import type { AgentAdapter, AgentResponse } from "./agent.js";

export type { Transcript, TranscriptBlock, TranscriptEntry, UsageTelemetry };

/**
 * One entry in an ordered model transcript. Aliased to the core
 * `TranscriptEntry` so an adapter response drops straight into a trial record.
 */
export type TranscriptMessage = TranscriptEntry;

/** A single input turn handed to a model adapter. */
export interface ModelInputMessage {
  role: "user" | "assistant";
  content: string;
}

/** The prompt handed to a model adapter. The system prompt is frozen on the
 * adapter itself, so only user/assistant turns are supplied here. */
export interface ModelPromptInput {
  messages: readonly ModelInputMessage[];
}

/**
 * How a model call resolved. `refused` and `truncated` are preserved failures,
 * never dropped; `error` means every attempt failed (retryable exhausted or a
 * non-retryable error), with the errors kept in `usage.errors`.
 */
export type ModelCompletionStatus =
  "completed" | "refused" | "truncated" | "error";

export interface ModelCompletion {
  status: ModelCompletionStatus;
  text: string;
  stopReason: string | null;
}

/** An agent response that also carries the verbatim transcript and usage. */
export interface ModelAgentResponse<Output> extends AgentResponse<Output> {
  transcript: Transcript;
  usage: UsageTelemetry;
}

/** An `AgentAdapter` whose responses preserve a transcript and usage. */
export interface ModelAgentAdapter<Input, Output> extends AgentAdapter<
  Input,
  Output
> {
  invoke(input: Input): Promise<ModelAgentResponse<Output>>;
}
