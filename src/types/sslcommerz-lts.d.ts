// The sslcommerz-lts package ships untyped CommonJS. Results stay `unknown`; src/lib/sslcommerz.ts narrows them.
declare module "sslcommerz-lts" {
  export default class SSLCommerzPayment {
    constructor(storeId: string, storePassword: string, live?: boolean);
    init(data: Record<string, unknown>): Promise<unknown>;
    validate(data: Record<string, unknown>): Promise<unknown>;
    initiateRefund(data: Record<string, unknown>): Promise<unknown>;
    refundQuery(data: Record<string, unknown>): Promise<unknown>;
    transactionQueryBySessionId(data: Record<string, unknown>): Promise<unknown>;
    transactionQueryByTransactionId(data: Record<string, unknown>): Promise<unknown>;
  }
}
