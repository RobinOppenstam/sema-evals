import { createServer, type Server } from "node:http";

import { ExactEvmScheme } from "@x402/evm";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPaymentFromConfig,
} from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { SEMANTIC_EXTENSION_URI, semanticExtensionSchema } from "./schemas.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412e0f4bb9a6c8e6e" as const;
const NETWORK = "eip155:84532";
const ASSET = "0x833589fCD6EDB6E08f4c7C32D4f71b54bda02913";
const PAY_TO = "0x0000000000000000000000000000000000000001";

export const x402SdkConformanceResultSchema = z.object({
  schemaVersion: z.literal("x402-sdk-transport-conformance-v1"),
  ready: z.boolean(),
  sdkIdentity: z.literal("@x402/core,@x402/fetch,@x402/evm@2.19.0"),
  checkedHeaders: z.array(z.string()),
  failures: z.array(z.string()),
  requestCounts: z.object({
    happy: z.number().int(),
    malformed: z.number().int(),
    v1: z.number().int(),
    repeated402: z.number().int(),
    invalidCaip2: z.number().int(),
    missingExtension: z.number().int(),
    invalidExtension: z.number().int(),
  }),
  externalNetworkAccessed: z.literal(false),
  attemptedExternalEgress: z.boolean(),
  productionWriteAttempted: z.literal(false),
});
export type X402SdkConformanceResult = z.infer<
  typeof x402SdkConformanceResultSchema
>;

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
function paymentRequired(
  url: string,
  extension: "valid" | "missing" | "invalid" = "valid",
  network = NETWORK,
) {
  const extensions =
    extension === "missing"
      ? {}
      : extension === "invalid"
        ? { [SEMANTIC_EXTENSION_URI]: { info: { malformed: true } } }
        : {
            [SEMANTIC_EXTENSION_URI]: {
              info: {
                contractId: "loopback-conformance",
                extensionUri: SEMANTIC_EXTENSION_URI,
                enforcement: "voluntary",
                requiredReferences: [
                  {
                    handle: "LoopbackTerm",
                    ref: "sema://loopback/term",
                    digest: "a".repeat(64),
                    canonicalizationVersion: "loopback-v1",
                  },
                ],
              },
              schema: { type: "object" },
            },
          };
  return {
    x402Version: 2,
    error: "payment required for loopback conformance fixture",
    resource: {
      url,
      description: "loopback-only x402 fixture",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network,
        amount: "1",
        asset: ASSET,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
    extensions,
  };
}
function paymentResponse() {
  return {
    success: true,
    transaction: "loopback-not-broadcast",
    network: NETWORK,
    payer: "unfunded-test-key",
    amount: "1",
  };
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("loopback server did not expose a TCP port");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

type FixtureKind =
  | "happy"
  | "malformed"
  | "v1"
  | "repeated402"
  | "invalidCaip2"
  | "missingExtension"
  | "invalidExtension";
interface FixtureRun {
  count: number;
  signature: string | null;
  responseHeader: string | null;
  error: string | null;
  status: number | null;
  attemptedExternalEgress: boolean;
}

function decodePaymentSignature(signature: string): {
  x402Version?: unknown;
  accepted?: { network?: unknown };
  extensions?: Record<string, unknown>;
} {
  return JSON.parse(Buffer.from(signature, "base64").toString("utf8")) as {
    x402Version?: unknown;
    accepted?: { network?: unknown };
    extensions?: Record<string, unknown>;
  };
}

/**
 * Runs the official V2 client against an ephemeral 127.0.0.1 server. The test
 * key only signs an authorization payload; it is unfunded and the fixture has
 * no RPC URL, facilitator, chain client, or production-write pathway.
 */
async function runFixture(kind: FixtureKind): Promise<FixtureRun> {
  let count = 0;
  let signature: string | null = null;
  let responseHeader: string | null = null;
  const server = createServer((request, response) => {
    count += 1;
    const paymentSignature = request.headers["payment-signature"];
    signature = Array.isArray(paymentSignature)
      ? (paymentSignature[0] ?? null)
      : (paymentSignature ?? null);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;
    if (kind === "malformed") {
      response.writeHead(402, { "PAYMENT-REQUIRED": "%%%not-base64-json%%%" });
      response.end();
      return;
    }
    if (kind === "v1") {
      response.writeHead(402, {
        "PAYMENT-REQUIRED": base64Json({ x402Version: 1 }),
      });
      response.end();
      return;
    }
    if (count === 1 || kind === "repeated402") {
      const extension =
        kind === "missingExtension"
          ? "missing"
          : kind === "invalidExtension"
            ? "invalid"
            : "valid";
      const network = kind === "invalidCaip2" ? "not-a-caip2-id" : NETWORK;
      response.writeHead(402, {
        "PAYMENT-REQUIRED": base64Json(
          paymentRequired(url, extension, network),
        ),
      });
      response.end();
      return;
    }
    responseHeader = base64Json(paymentResponse());
    response.writeHead(200, {
      "PAYMENT-RESPONSE": responseHeader,
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  try {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const fixtureUrl = `http://127.0.0.1:${port}/paid`;
    let attemptedExternalEgress = false;
    const loopbackOnlyFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== fixtureUrl) {
        attemptedExternalEgress = true;
        throw new Error(
          `Blocked non-loopback conformance egress to ${request.url}.`,
        );
      }
      return fetch(request);
    };
    const paidFetch = wrapFetchWithPaymentFromConfig(loopbackOnlyFetch, {
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    });
    try {
      const response = await paidFetch(fixtureUrl);
      return {
        count,
        signature,
        responseHeader,
        error: null,
        status: response.status,
        attemptedExternalEgress,
      };
    } catch (error) {
      return {
        count,
        signature,
        responseHeader,
        error: error instanceof Error ? error.message : String(error),
        status: null,
        attemptedExternalEgress,
      };
    }
  } finally {
    await close(server);
  }
}

export async function runX402SdkTransportConformance(): Promise<X402SdkConformanceResult> {
  const failures: string[] = [];
  const [
    happy,
    malformed,
    v1,
    repeated402,
    invalidCaip2,
    missingExtension,
    invalidExtension,
  ] = await Promise.all([
    runFixture("happy"),
    runFixture("malformed"),
    runFixture("v1"),
    runFixture("repeated402"),
    runFixture("invalidCaip2"),
    runFixture("missingExtension"),
    runFixture("invalidExtension"),
  ]);
  const attemptedExternalEgress = [
    happy,
    malformed,
    v1,
    repeated402,
    invalidCaip2,
    missingExtension,
    invalidExtension,
  ].some((fixture) => fixture.attemptedExternalEgress);
  if (attemptedExternalEgress)
    failures.push("conformance-fixture-attempted-external-egress");
  if (
    happy.status !== 200 ||
    happy.count !== 2 ||
    !happy.signature ||
    !happy.responseHeader
  )
    failures.push("v2-payment-retry-did-not-complete-over-loopback");
  if (happy.signature) {
    try {
      const payload = decodePaymentSignature(happy.signature);
      if (payload.x402Version !== 2)
        failures.push("payment-signature-was-not-v2");
      if (payload.accepted?.network !== NETWORK)
        failures.push("payment-signature-lost-caip2-network");
      if (!(SEMANTIC_EXTENSION_URI in (payload.extensions ?? {})))
        failures.push("payment-signature-lost-top-level-extension");
    } catch {
      failures.push("payment-signature-was-not-decodable-json");
    }
  }
  if (happy.responseHeader) {
    try {
      const decoded = decodePaymentResponseHeader(happy.responseHeader);
      if (decoded.network !== NETWORK || decoded.success !== true)
        failures.push("payment-response-was-not-v2-compatible");
    } catch {
      failures.push("payment-response-was-not-decodable");
    }
  }
  if (malformed.count !== 1 || !malformed.error)
    failures.push("malformed-payment-required-did-not-fail-closed");
  if (v1.count !== 1 || !v1.error)
    failures.push("v1-payment-required-was-not-rejected-by-v2-client");
  if (invalidCaip2.count !== 1 || !invalidCaip2.error)
    failures.push("invalid-caip2-payment-required-did-not-fail-closed");
  if (
    repeated402.count !== 2 ||
    !repeated402.signature ||
    repeated402.status !== 402
  )
    failures.push("repeat-402-did-not-stop-after-one-payment-attempt");
  if (
    missingExtension.count !== 2 ||
    !missingExtension.signature ||
    SEMANTIC_EXTENSION_URI in
      (decodePaymentSignature(missingExtension.signature).extensions ?? {})
  )
    failures.push("missing-semantic-extension-was-not-observable");
  if (!invalidExtension.signature) {
    failures.push("invalid-semantic-extension-did-not-reach-wire-check");
  } else {
    const invalid = decodePaymentSignature(invalidExtension.signature)
      .extensions?.[SEMANTIC_EXTENSION_URI];
    if (semanticExtensionSchema.safeParse(invalid).success)
      failures.push("invalid-semantic-extension-passed-sema-schema");
  }
  return x402SdkConformanceResultSchema.parse({
    schemaVersion: "x402-sdk-transport-conformance-v1",
    ready: failures.length === 0,
    sdkIdentity: "@x402/core,@x402/fetch,@x402/evm@2.19.0",
    checkedHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-SIGNATURE",
      "PAYMENT-RESPONSE",
    ],
    failures,
    requestCounts: {
      happy: happy.count,
      malformed: malformed.count,
      v1: v1.count,
      repeated402: repeated402.count,
      invalidCaip2: invalidCaip2.count,
      missingExtension: missingExtension.count,
      invalidExtension: invalidExtension.count,
    },
    // The guard rejects non-loopback URLs before fetch can access them.
    externalNetworkAccessed: false,
    attemptedExternalEgress,
    productionWriteAttempted: false,
  });
}
