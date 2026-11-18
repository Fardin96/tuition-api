import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreateSessionInput,
  createSslcommerzGateway,
  GatewayError,
  getPaymentGateway,
  isSuccessStatus,
  mapTransaction,
  type PaymentGateway,
  paymentsConfigured,
  setPaymentGatewayForTests,
} from "./sslcommerz.js";

// Mutable copy of env so each test can switch payments on and off without a DB-backed reload.
const sslEnv = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("../config/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/env.js")>();
  Object.assign(sslEnv, actual.env);
  return { env: sslEnv };
});

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  validate: vi.fn(),
  transactionQueryByTransactionId: vi.fn(),
  initiateRefund: vi.fn(),
  refundQuery: vi.fn(),
}));
vi.mock("sslcommerz-lts", () => ({
  default: class {
    init = sdk.init;
    validate = sdk.validate;
    transactionQueryByTransactionId = sdk.transactionQueryByTransactionId;
    initiateRefund = sdk.initiateRefund;
    refundQuery = sdk.refundQuery;
  },
}));

const PASSWORD = "pw-secret-123";

function gateway(timeoutMs?: number) {
  return createSslcommerzGateway({
    storeId: "store_test",
    storePassword: PASSWORD,
    isLive: false,
    timeoutMs,
  });
}

async function catchError(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GatewayError) return err;
    throw err;
  }
  throw new Error("expected the promise to reject");
}

const session: CreateSessionInput = {
  tranId: "TRN1",
  totalAmount: "10.00",
  productName: "Placement fee",
  customer: { name: "Tutor One", email: "tutor@example.com", phone: "01700000000", city: "Dhaka" },
  urls: {
    success: "http://localhost:4000/api/v1/payments/sslcommerz/success",
    fail: "http://localhost:4000/api/v1/payments/sslcommerz/fail",
    cancel: "http://localhost:4000/api/v1/payments/sslcommerz/cancel",
    ipn: "http://localhost:4000/api/v1/payments/sslcommerz/ipn",
  },
  valueA: "fee-1",
};

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  Object.assign(sslEnv, {
    SSLC_STORE_ID: undefined,
    SSLC_STORE_PASSWORD: undefined,
    SSLC_IS_LIVE: "false",
    API_PUBLIC_URL: undefined,
    WEB_PUBLIC_URL: undefined,
  });
  setPaymentGatewayForTests(null);
});

describe("createSession", () => {
  it("returns the session key and gateway page when the gateway accepts it", async () => {
    sdk.init.mockResolvedValue({
      status: "SUCCESS",
      sessionkey: "SK1",
      GatewayPageURL: "https://sandbox.sslcommerz.com/gw/SK1",
    });

    const result = await gateway().createSession(session);

    expect(result).toEqual({
      sessionKey: "SK1",
      gatewayUrl: "https://sandbox.sslcommerz.com/gw/SK1",
    });
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        total_amount: "10.00",
        currency: "BDT",
        tran_id: "TRN1",
        num_of_item: 1,
        cus_city: "Dhaka",
        cus_phone: "01700000000",
        value_a: "fee-1",
      }),
    );
  });

  it("throws a rejected GatewayError carrying the gateway's failedreason", async () => {
    sdk.init.mockResolvedValue({ status: "FAILED", failedreason: "Invalid store credentials" });

    const err = await catchError(gateway().createSession(session));

    expect(err.kind).toBe("rejected");
    expect(err.message).toBe("Invalid store credentials");
  });
});

describe("transport failures", () => {
  it("turns an SDK Error into unavailable and keeps the password out of the message", async () => {
    sdk.validate.mockResolvedValue(
      new Error(
        `request to https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=V1&store_id=store_test&store_passwd=${PASSWORD}&v=1 failed`,
      ),
    );

    const err = await catchError(gateway().validate("V1"));

    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).toContain("store_passwd=***");
  });

  it("times out a call that never settles and reports it as unavailable", async () => {
    sdk.init.mockReturnValue(new Promise(() => {}));

    const err = await catchError(gateway(20).createSession(session));

    expect(err.kind).toBe("unavailable");
    expect(err.message).toBe("Gateway timed out");
  });

  it("treats a non-object response as unavailable", async () => {
    sdk.validate.mockResolvedValue("<html>oops</html>");

    const err = await catchError(gateway().validate("V1"));

    expect(err.kind).toBe("unavailable");
  });

  it("refuses an unsafe val_id before calling the SDK", async () => {
    const err = await catchError(gateway().validate("V1&store_id=other"));

    expect(err.kind).toBe("rejected");
    expect(sdk.validate).not.toHaveBeenCalled();
  });
});

describe("validate", () => {
  it("maps the gateway payload and strips secrets from raw", async () => {
    sdk.validate.mockResolvedValue({
      status: "VALID",
      tran_id: "TRN1",
      val_id: "V1",
      amount: "10.00",
      currency_type: "BDT",
      currency_amount: "10.00",
      bank_tran_id: "BANK1",
      card_type: "VISA-Dutch Bangla",
      risk_level: "1",
      risk_title: "Medium Risk",
      store_passwd: "leaked",
      verify_sign: "sig",
    });

    const tx = await gateway().validate("V1");

    expect(tx).toMatchObject({
      status: "VALID",
      tranId: "TRN1",
      valId: "V1",
      amount: "10.00",
      currencyType: "BDT",
      currencyAmount: "10.00",
      bankTranId: "BANK1",
      cardType: "VISA-Dutch Bangla",
      riskLevel: 1,
      riskTitle: "Medium Risk",
    });
    expect(tx.raw).toEqual({
      status: "VALID",
      tran_id: "TRN1",
      val_id: "V1",
      amount: "10.00",
      currency_type: "BDT",
      currency_amount: "10.00",
      bank_tran_id: "BANK1",
      card_type: "VISA-Dutch Bangla",
      risk_level: "1",
      risk_title: "Medium Risk",
    });
  });

  it("maps empty strings to null and an empty risk level to null", async () => {
    sdk.validate.mockResolvedValue({
      status: "VALID",
      tran_id: "TRN1",
      val_id: "",
      amount: "10.00",
      currency_type: "BDT",
      currency_amount: "10.00",
      bank_tran_id: "",
      card_type: "",
      risk_level: "",
      risk_title: "",
    });

    const tx = await gateway().validate("V1");

    expect(tx.valId).toBeNull();
    expect(tx.bankTranId).toBeNull();
    expect(tx.cardType).toBeNull();
    expect(tx.riskLevel).toBeNull();
    expect(tx.riskTitle).toBeNull();
  });

  it("returns INVALID_TRANSACTION as a normal answer", async () => {
    sdk.validate.mockResolvedValue({ status: "INVALID_TRANSACTION" });

    const tx = await gateway().validate("V9");

    expect(tx.status).toBe("INVALID_TRANSACTION");
    expect(isSuccessStatus(tx.status)).toBe(false);
  });
});

describe("queryByTranId", () => {
  it("is unavailable when APIConnect is not DONE", async () => {
    sdk.transactionQueryByTransactionId.mockResolvedValue({ APIConnect: "FAILED" });

    const err = await catchError(gateway().queryByTranId("TRN1"));

    expect(err.kind).toBe("unavailable");
    expect(err.message).toBe("Gateway query failed: FAILED");
  });

  it("maps every element when APIConnect is DONE", async () => {
    sdk.transactionQueryByTransactionId.mockResolvedValue({
      APIConnect: "DONE",
      no_of_trans_found: 1,
      element: [
        {
          status: "VALID",
          tran_id: "TRN1",
          val_id: "V1",
          amount: "10.00",
          currency_type: "BDT",
          currency_amount: "10.00",
        },
      ],
    });

    const txs = await gateway().queryByTranId("TRN1");

    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ status: "VALID", tranId: "TRN1", valId: "V1" });
  });

  it("returns an empty list when DONE has no element field", async () => {
    sdk.transactionQueryByTransactionId.mockResolvedValue({ APIConnect: "DONE" });

    expect(await gateway().queryByTranId("TRN1")).toEqual([]);
  });
});

describe("initiateRefund", () => {
  const refund = {
    bankTranId: "BANK1",
    amount: "1500.00",
    remarks: "Fee & term 1",
    refeId: "REFE1",
  };

  it("sends the remarks URL-encoded, so spaces and & cannot split the query string", async () => {
    sdk.initiateRefund.mockResolvedValue({ APIConnect: "DONE", status: "SUCCESS" });

    await gateway().initiateRefund(refund);

    expect(sdk.initiateRefund).toHaveBeenCalledWith({
      bank_tran_id: "BANK1",
      refund_amount: "1500.00",
      refund_remarks: "Fee%20%26%20term%201",
      refe_id: "REFE1",
    });
  });

  it("truncates remarks to 200 characters before encoding", async () => {
    sdk.initiateRefund.mockResolvedValue({ APIConnect: "DONE", status: "SUCCESS" });

    await gateway().initiateRefund({ ...refund, remarks: "x".repeat(250) });

    expect(sdk.initiateRefund).toHaveBeenCalledWith(
      expect.objectContaining({ refund_remarks: "x".repeat(200) }),
    );
  });

  it.each([
    ["a bank_tran_id with URL syntax", { bankTranId: "BANK1&store_id=other" }],
    ["a refe_id with a space", { refeId: "REFE 1" }],
    ["an amount without two decimals", { amount: "10" }],
    ["an amount with a thousands separator", { amount: "1,000.00" }],
  ])("refuses %s as rejected, without calling the SDK", async (_label, override) => {
    const err = await catchError(gateway().initiateRefund({ ...refund, ...override }));

    expect(err.kind).toBe("rejected");
    expect(sdk.initiateRefund).not.toHaveBeenCalled();
  });

  it("is rejected when APIConnect is not DONE", async () => {
    sdk.initiateRefund.mockResolvedValue({ APIConnect: "INVALID_CREDENTIAL" });

    const err = await catchError(gateway().initiateRefund(refund));

    expect(err.kind).toBe("rejected");
    expect(err.message).toBe("Gateway refused the refund: INVALID_CREDENTIAL");
  });

  it("is unavailable when the SDK resolves an Error, and keeps the password out of the message", async () => {
    sdk.initiateRefund.mockResolvedValue(
      new Error(
        `request to https://sandbox.sslcommerz.com/validator/api/merchantTransIDvalidationAPI.php?refund_amount=1500.00&store_passwd=${PASSWORD} failed`,
      ),
    );

    const err = await catchError(gateway().initiateRefund(refund));

    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).toContain("store_passwd=***");
  });

  it("keeps the password out of a rejected message that echoes it", async () => {
    sdk.initiateRefund.mockResolvedValue({ APIConnect: `store_passwd=${PASSWORD}` });

    const err = await catchError(gateway().initiateRefund(refund));

    expect(err.kind).toBe("rejected");
    expect(err.message).not.toContain(PASSWORD);
  });

  it("lowercases the status and maps refund_ref_id", async () => {
    sdk.initiateRefund.mockResolvedValue({
      APIConnect: "DONE",
      status: "SUCCESS",
      refund_ref_id: "RR-100",
    });

    const result = await gateway().initiateRefund(refund);

    expect(result).toMatchObject({ status: "success", refundRefId: "RR-100", errorReason: null });
  });

  it("maps a failed refund's errorReason and an empty refund_ref_id to null", async () => {
    sdk.initiateRefund.mockResolvedValue({
      APIConnect: "DONE",
      status: "FAILED",
      refund_ref_id: "",
      errorReason: "Insufficient balance",
    });

    const result = await gateway().initiateRefund(refund);

    expect(result).toMatchObject({
      status: "failed",
      refundRefId: null,
      errorReason: "Insufficient balance",
    });
  });

  it("keeps store_passwd, store_id and verify keys out of raw", async () => {
    sdk.initiateRefund.mockResolvedValue({
      APIConnect: "DONE",
      status: "SUCCESS",
      refund_ref_id: "RR-100",
      store_passwd: "leaked",
      store_id: "store_test",
      verify_key: "k",
      verify_sign: "sig",
    });

    const result = await gateway().initiateRefund(refund);

    expect(result.raw).toEqual({ APIConnect: "DONE", status: "SUCCESS", refund_ref_id: "RR-100" });
  });
});

describe("queryRefund", () => {
  it("looks the refund up by refund_ref_id and maps the answer", async () => {
    sdk.refundQuery.mockResolvedValue({
      APIConnect: "DONE",
      status: "REFUNDED",
      refund_ref_id: "RR-100",
      refunded_on: "2026-11-18 10:00:00",
      errorReason: "",
    });

    const result = await gateway().queryRefund("RR-100");

    expect(sdk.refundQuery).toHaveBeenCalledWith({ refund_ref_id: "RR-100" });
    expect(result).toMatchObject({
      status: "refunded",
      refundRefId: "RR-100",
      refundedOn: "2026-11-18 10:00:00",
      errorReason: null,
    });
  });

  it("keeps store_passwd and store_id out of raw", async () => {
    sdk.refundQuery.mockResolvedValue({
      APIConnect: "DONE",
      status: "PROCESSING",
      store_passwd: "leaked",
      store_id: "store_test",
    });

    const result = await gateway().queryRefund("RR-100");

    expect(result.status).toBe("processing");
    expect(result.raw).toEqual({ APIConnect: "DONE", status: "PROCESSING" });
  });

  it("is unavailable when APIConnect is not DONE", async () => {
    sdk.refundQuery.mockResolvedValue({ APIConnect: "FAILED" });

    const err = await catchError(gateway().queryRefund("RR-100"));

    expect(err.kind).toBe("unavailable");
    expect(err.message).toBe("Gateway refund query failed: FAILED");
  });

  it("refuses an unsafe refund_ref_id before calling the SDK", async () => {
    const err = await catchError(gateway().queryRefund("RR-100&store_id=other"));

    expect(err.kind).toBe("rejected");
    expect(sdk.refundQuery).not.toHaveBeenCalled();
  });

  it("is unavailable when the SDK resolves an Error, and keeps the password out of the message", async () => {
    sdk.refundQuery.mockResolvedValue(
      new Error(`request failed: merchantTransIDvalidationAPI.php?store_passwd=${PASSWORD}`),
    );

    const err = await catchError(gateway().queryRefund("RR-100"));

    expect(err.kind).toBe("unavailable");
    expect(err.message).not.toContain(PASSWORD);
  });
});

describe("mapTransaction", () => {
  it("drops password, store id and verify keys from raw", () => {
    const tx = mapTransaction({
      status: "VALID",
      tran_id: "TRN1",
      amount: "10.00",
      store_passwd: "x",
      store_id: "s",
      verify_key: "k",
      verify_sign: "sig",
    });

    expect(tx.raw).toEqual({ status: "VALID", tran_id: "TRN1", amount: "10.00" });
  });
});

describe("getPaymentGateway", () => {
  it("throws PAYMENTS_DISABLED when the store is not configured", () => {
    let caught: unknown;
    try {
      getPaymentGateway();
    } catch (err) {
      caught = err;
    }

    expect(paymentsConfigured()).toBe(false);
    expect(caught).toMatchObject({
      code: "PAYMENTS_DISABLED",
      statusCode: 503,
      message: "Online payments are turned off right now.",
    });
  });

  it("requires all four settings before payments count as configured", () => {
    Object.assign(sslEnv, {
      SSLC_STORE_ID: "store_test",
      SSLC_STORE_PASSWORD: PASSWORD,
      API_PUBLIC_URL: "http://localhost:4000",
    });
    expect(paymentsConfigured()).toBe(false);

    sslEnv.WEB_PUBLIC_URL = "http://localhost:3000";
    expect(paymentsConfigured()).toBe(true);
  });

  it("returns the test override even when payments are not configured", () => {
    const fake: PaymentGateway = {
      createSession: vi.fn(),
      validate: vi.fn(),
      queryByTranId: vi.fn(),
      initiateRefund: vi.fn(),
      queryRefund: vi.fn(),
    };
    setPaymentGatewayForTests(fake);

    expect(getPaymentGateway()).toBe(fake);
  });
});
