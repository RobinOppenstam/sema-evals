import { utf8Bytes } from "@sema-evals/core";

import type {
  PaymentPayload,
  PaymentRequirementsResponse,
  SettlementResponse,
} from "./schemas.js";

/**
 * A deterministic, in-process x402 exchange. It moves a 402 requirements
 * response from the seller to the payer, and optionally a PaymentPayload back,
 * without any network, SDK, or chain — determinism and dependency-lightness win
 * (ADR 0016). It records the wire bytes crossing the boundary so the experiment
 * can price the extension's wire overhead.
 */
export interface DeliveredRequirements {
  response: PaymentRequirementsResponse;
  wireBytes: number;
  transport: string;
}

export interface DeliveredPayment {
  payload: PaymentPayload;
  wireBytes: number;
  transport: string;
}

export interface DeliveredSettlement {
  settlement: SettlementResponse;
  wireBytes: number;
  transport: string;
}

export class InProcessX402Transport {
  public readonly transport = "in-process-x402-v1";

  public deliverRequirements(
    response: PaymentRequirementsResponse,
  ): DeliveredRequirements {
    return {
      response,
      wireBytes: utf8Bytes(response),
      transport: this.transport,
    };
  }

  public deliverPayment(payload: PaymentPayload): DeliveredPayment {
    return {
      payload,
      wireBytes: utf8Bytes(payload),
      transport: this.transport,
    };
  }

  public deliverSettlement(
    settlement: SettlementResponse,
  ): DeliveredSettlement {
    return {
      settlement,
      wireBytes: utf8Bytes(settlement),
      transport: this.transport,
    };
  }
}
