import SSLCommerzPayment from "sslcommerz-lts";
import { env } from "../config/env.js";
import { appError } from "./errors.js";

// The SDK resolves with an Error on network failure, has no timeout, and puts store_passwd in URLs.
// Everything goes through this module; never call SSLCommerz with raw fetch.

export type GatewayStatus = string; // VALID | VALIDATED | FAILED | CANCELLED | UNATTEMPTED | EXPIRED | INVALID_TRANSACTION | PENDING ...

export type GatewayTransaction = {
  status: GatewayStatus;
  tranId: string;
  valId: string | null;
  amount: string; // "105.50"
  currencyType: string;
  currencyAmount: string;
  bankTranId: string | null;
  cardType: string | null;
  riskLevel: number | null;
  riskTitle: string | null;
  raw: Record<string, unknown>; // sanitized payload
};

export type CreateSessionInput = {
  tranId: string;
  totalAmount: string;
  productName: string;
  customer: { name: string; email: string; phone: string; city: string };
  urls: { success: string; fail: string; cancel: string; ipn: string };
  valueA?: string;
};

export type RefundInput = {
  bankTranId: string;
  amount: string; // "1500.00"
  remarks: string;
  refeId: string; // our payment_refund id
};

// initiateRefund answer. status is the gateway's word: "success" (accepted, processing),
// "processing" (already accepted earlier) or "failed". Anything else is unknown.
export type RefundInitResult = {
  status: string;
  refundRefId: string | null;
  errorReason: string | null;
  raw: Record<string, unknown>;
};

// refundQuery answer. status: "refunded", "processing" or "cancelled".
export type RefundQueryResult = {
  status: string;
  refundRefId: string | null;
  refundedOn: string | null;
  errorReason: string | null;
  raw: Record<string, unknown>;
};

export interface PaymentGateway {
  createSession(input: CreateSessionInput): Promise<{ sessionKey: string; gatewayUrl: string }>;
  validate(valId: string): Promise<GatewayTransaction>;
  queryByTranId(tranId: string): Promise<GatewayTransaction[]>; // [] when none found
  // "rejected": the gateway refused the request, so no refund started. "unavailable": the outcome
  // is unknown (timeout, network), so the refund may or may not have started.
  initiateRefund(input: RefundInput): Promise<RefundInitResult>;
  // "unavailable" when the gateway cannot answer.
  queryRefund(refundRefId: string): Promise<RefundQueryResult>;
}

export class GatewayError extends Error {
  kind: "rejected" | "unavailable";

  constructor(kind: "rejected" | "unavailable", message: string) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
  }
}

const GATEWAY_TIMEOUT_MS = 15_000;
// The SDK builds validate/query URLs by string interpolation, so IDs must not carry URL syntax.
const SAFE_ID = /^[\w.-]{1,64}$/;
const SECRET_KEY = /passw|store_id|verify_key|verify_sign/i;

type Raw = Record<string, unknown>;

export function isSuccessStatus(status: string): boolean {
  return status === "VALID" || status === "VALIDATED";
}

function isRecord(value: unknown): value is Raw {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function orNull(value: unknown): string | null {
  const v = text(value);
  return v === "" ? null : v;
}

function riskLevelOf(value: unknown): number | null {
  const v = text(value);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapTransaction(obj: Raw): GatewayTransaction {
  return {
    status: text(obj.status),
    tranId: text(obj.tran_id),
    valId: orNull(obj.val_id),
    amount: text(obj.amount),
    currencyType: text(obj.currency_type),
    currencyAmount: text(obj.currency_amount),
    bankTranId: orNull(obj.bank_tran_id),
    cardType: orNull(obj.card_type),
    riskLevel: riskLevelOf(obj.risk_level),
    riskTitle: orNull(obj.risk_title),
    raw: sanitized(obj),
  };
}

function sanitized(obj: Raw): Raw {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !SECRET_KEY.test(key)));
}

const REFUND_AMOUNT = /^\d{1,10}\.\d{2}$/;

function scrub(message: string, storePassword: string): string {
  const masked = message.replace(/store_passwd=[^&\s]*/g, "store_passwd=***");
  return [storePassword, encodeURIComponent(storePassword)]
    .filter((secret) => secret.length > 0)
    .reduce((acc, secret) => acc.replaceAll(secret, "***"), masked);
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID.test(value)) throw new GatewayError("rejected", `Invalid ${field}`);
}

export type SslcommerzOptions = {
  storeId: string;
  storePassword: string;
  isLive: boolean;
  timeoutMs?: number;
};

export function createSslcommerzGateway({
  storeId,
  storePassword,
  isLive,
  timeoutMs = GATEWAY_TIMEOUT_MS,
}: SslcommerzOptions): PaymentGateway {
  const client = new SSLCommerzPayment(storeId, storePassword, isLive);
  const clean = (message: string) => scrub(message, storePassword);

  async function call(run: () => Promise<unknown>): Promise<Raw> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GatewayError("unavailable", "Gateway timed out")),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([run(), timedOut]);
      if (result instanceof Error) {
        throw new GatewayError("unavailable", clean(`Gateway request failed: ${result.message}`));
      }
      if (!isRecord(result)) {
        throw new GatewayError("unavailable", "Gateway returned an unexpected response");
      }
      return result;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new GatewayError("unavailable", clean(`Gateway request failed: ${message}`));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createSession(input) {
      const res = await call(() =>
        client.init({
          total_amount: input.totalAmount,
          currency: "BDT",
          tran_id: input.tranId,
          success_url: input.urls.success,
          fail_url: input.urls.fail,
          cancel_url: input.urls.cancel,
          ipn_url: input.urls.ipn,
          shipping_method: "NO",
          num_of_item: 1,
          product_name: input.productName,
          product_category: "Service",
          product_profile: "non-physical-goods",
          cus_name: input.customer.name,
          cus_email: input.customer.email,
          cus_add1: input.customer.city,
          cus_city: input.customer.city,
          cus_postcode: "1000",
          cus_country: "Bangladesh",
          cus_phone: input.customer.phone,
          value_a: input.valueA,
        }),
      );
      const sessionKey = text(res.sessionkey);
      const gatewayUrl = text(res.GatewayPageURL);
      if (text(res.status) === "SUCCESS" && sessionKey && gatewayUrl) {
        return { sessionKey, gatewayUrl };
      }
      throw new GatewayError(
        "rejected",
        clean(text(res.failedreason)) || "Gateway refused the session",
      );
    },

    async validate(valId) {
      assertSafeId(valId, "val_id");
      const res = await call(() => client.validate({ val_id: valId }));
      return mapTransaction(res);
    },

    async queryByTranId(tranId) {
      assertSafeId(tranId, "tran_id");
      const res = await call(() => client.transactionQueryByTransactionId({ tran_id: tranId }));
      if (res.APIConnect !== "DONE") {
        throw new GatewayError(
          "unavailable",
          clean(`Gateway query failed: ${text(res.APIConnect)}`),
        );
      }
      const elements = Array.isArray(res.element) ? res.element : [];
      return elements.filter(isRecord).map(mapTransaction);
    },

    async initiateRefund(input) {
      assertSafeId(input.bankTranId, "bank_tran_id");
      assertSafeId(input.refeId, "refe_id");
      if (!REFUND_AMOUNT.test(input.amount)) {
        throw new GatewayError("rejected", "Invalid refund amount");
      }
      // The SDK interpolates these into the URL without encoding.
      const remarks = encodeURIComponent(input.remarks.slice(0, 200));
      const res = await call(() =>
        client.initiateRefund({
          bank_tran_id: input.bankTranId,
          refund_amount: input.amount,
          refund_remarks: remarks,
          refe_id: input.refeId,
        }),
      );
      // APIConnect other than DONE: the request was refused (credentials, permission, inactive store).
      if (res.APIConnect !== "DONE") {
        throw new GatewayError(
          "rejected",
          clean(`Gateway refused the refund: ${text(res.APIConnect) || "no answer"}`),
        );
      }
      return {
        status: text(res.status).toLowerCase(),
        refundRefId: orNull(res.refund_ref_id),
        errorReason: orNull(res.errorReason),
        raw: sanitized(res),
      };
    },

    async queryRefund(refundRefId) {
      assertSafeId(refundRefId, "refund_ref_id");
      const res = await call(() => client.refundQuery({ refund_ref_id: refundRefId }));
      if (res.APIConnect !== "DONE") {
        throw new GatewayError(
          "unavailable",
          clean(`Gateway refund query failed: ${text(res.APIConnect)}`),
        );
      }
      return {
        status: text(res.status).toLowerCase(),
        refundRefId: orNull(res.refund_ref_id),
        refundedOn: orNull(res.refunded_on),
        errorReason: orNull(res.errorReason),
        raw: sanitized(res),
      };
    },
  };
}

let testGateway: PaymentGateway | null = null;
let realGateway: PaymentGateway | null = null;

export function paymentsConfigured(): boolean {
  return Boolean(
    env.SSLC_STORE_ID && env.SSLC_STORE_PASSWORD && env.API_PUBLIC_URL && env.WEB_PUBLIC_URL,
  );
}

export function setPaymentGatewayForTests(gateway: PaymentGateway | null): void {
  testGateway = gateway;
}

export function getPaymentGateway(): PaymentGateway {
  if (testGateway) return testGateway;
  const { SSLC_STORE_ID: storeId, SSLC_STORE_PASSWORD: storePassword } = env;
  if (!paymentsConfigured() || !storeId || !storePassword) {
    throw appError("PaymentsDisabled", 503, "Online payments are turned off right now.");
  }
  realGateway ??= createSslcommerzGateway({
    storeId,
    storePassword,
    isLive: env.SSLC_IS_LIVE === "true",
  });
  return realGateway;
}
