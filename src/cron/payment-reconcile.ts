import { prisma } from "../lib/prisma.js";
import { runPaymentReconcile } from "../modules/payment/payment-reconcile.service.js";

async function main(): Promise<number> {
  const result = await runPaymentReconcile({ log: (msg) => console.warn(msg) });
  if (result.skipped) {
    console.log("payment-reconcile skipped: payments not configured");
    return 0;
  }
  console.log(
    `payment-reconcile complete: checked ${result.checked}, settled ${result.settled}, review ${result.review}, unapplied ${result.unapplied}, ended ${result.ended}, pending ${result.stillPending}, gateway errors ${result.gatewayErrors}, failed ${result.failed}`,
  );
  if (result.aborted) {
    console.error("payment-reconcile aborted: the gateway kept failing");
  }
  if (result.failed > 0) {
    console.error(`payment-reconcile: ${result.failed} attempt(s) failed with an unexpected error`);
  }
  return result.aborted || result.failed > 0 ? 1 : 0;
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
