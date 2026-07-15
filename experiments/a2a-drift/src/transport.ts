import { utf8Bytes } from "@sema-evals/core";

import type { A2aMessage } from "./schemas.js";

/**
 * A deterministic, in-process A2A transport. It moves a task message from the
 * requester to the worker without any network or external SDK — determinism and
 * dependency-lightness win (ADR 0012). It records the wire bytes crossing the
 * boundary so the experiment can price the extension's wire overhead. A real
 * transport (HTTP+JSON-RPC / gRPC) is drop-in future work; nothing here depends
 * on the channel being in-process except the absence of I/O.
 */
export interface DeliveredMessage {
  message: A2aMessage;
  wireBytes: number;
  transport: string;
}

export class InProcessA2ATransport {
  public readonly transport = "in-process-a2a-v1";

  public deliver(message: A2aMessage): DeliveredMessage {
    // The wire payload is the serialized A2A message: text part(s) plus any
    // tagged DataParts. Baseline carries only the task + handle names; the
    // extension conditions additionally carry the acceptance contract, so this
    // is exactly the addressing wire overhead.
    return {
      message,
      wireBytes: utf8Bytes(message),
      transport: this.transport,
    };
  }
}
