import { prisma } from "../lib/prisma.js";
import { runPaymentReconcile } from "../modules/payment/payment-reconcile.service.js";
import { runRefundReconcile } from "../modules/refunds/refund-reconcile.service.js";

async function main(): Promise<number> {
  const log = (msg: string) => console.warn(msg);
  let code = 0;

  const result = await runPaymentReconcile({ log });
  if (result.skipped) {
    console.log("payment-reconcile skipped: payments not configured");
  } else {
    console.log(
      `payment-reconcile complete: checked ${result.checked}, settled ${result.settled}, review ${result.review}, unapplied ${result.unapplied}, ended ${result.ended}, pending ${result.stillPending}, gateway errors ${result.gatewayErrors}, failed ${result.failed}`,
    );
    if (result.aborted) {
      console.error("payment-reconcile aborted: the gateway kept failing");
    }
    if (result.failed > 0) {
      console.error(
        `payment-reconcile: ${result.failed} attempt(s) failed with an unexpected error`,
      );
    }
    if (result.aborted || result.failed > 0) code = 1;
  }

  const refunds = await runRefundReconcile({ log });
  if (refunds.skipped) {
    console.log("refund-reconcile skipped: payments not configured");
  } else {
    console.log(
      `refund-reconcile complete: checked ${refunds.checked}, succeeded ${refunds.succeeded}, failed ${refunds.failed}, still processing ${refunds.stillProcessing}, needs review ${refunds.needsReview}, gateway errors ${refunds.gatewayErrors}, errors ${refunds.errors}`,
    );
    if (refunds.aborted) {
      console.error("refund-reconcile aborted: the gateway kept failing");
    }
    if (refunds.errors > 0) {
      console.error(
        `refund-reconcile: ${refunds.errors} refund(s) failed with an unexpected error`,
      );
    }
    if (refunds.aborted || refunds.errors > 0) code = 1;
  }

  return code;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    if (code !== 0) process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
