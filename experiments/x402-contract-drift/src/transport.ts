import { utf8Bytes } from "@sema-evals/core";

import type {
  PaymentPayload,
  PaymentRequirementsResponse,
  SettlementResponse,
} from "./schemas.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
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
  headerName: typeof PAYMENT_REQUIRED_HEADER;
  headerValue: string;
  wireBytes: number;
  transport: string;
}

export interface DeliveredPayment {
  payload: PaymentPayload;
  headerName: typeof PAYMENT_SIGNATURE_HEADER;
  headerValue: string;
  wireBytes: number;
  transport: string;
}

export interface DeliveredSettlement {
  settlement: SettlementResponse;
  headerName: typeof PAYMENT_RESPONSE_HEADER;
  headerValue: string;
  wireBytes: number;
  transport: string;
}

export class InProcessX402Transport {
  public readonly transport = "in-process-x402-v2";

  private encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  }

  public deliverRequirements(
    response: PaymentRequirementsResponse,
  ): DeliveredRequirements {
    const headerValue = this.encode(response);
    return {
      response,
      headerName: PAYMENT_REQUIRED_HEADER,
      headerValue,
      wireBytes: utf8Bytes({
        header: PAYMENT_REQUIRED_HEADER,
        value: headerValue,
      }),
      transport: this.transport,
    };
  }

  public deliverPayment(payload: PaymentPayload): DeliveredPayment {
    const headerValue = this.encode(payload);
    return {
      payload,
      headerName: PAYMENT_SIGNATURE_HEADER,
      headerValue,
      wireBytes: utf8Bytes({
        header: PAYMENT_SIGNATURE_HEADER,
        value: headerValue,
      }),
      transport: this.transport,
    };
  }

  public deliverSettlement(
    settlement: SettlementResponse,
  ): DeliveredSettlement {
    const headerValue = this.encode(settlement);
    return {
      settlement,
      headerName: PAYMENT_RESPONSE_HEADER,
      headerValue,
      wireBytes: utf8Bytes({
        header: PAYMENT_RESPONSE_HEADER,
        value: headerValue,
      }),
      transport: this.transport,
    };
  }
}
