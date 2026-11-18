// Creates one ৳10.00 sandbox session and queries it back. Run: yarn sslc:smoke
// Needs SSLC_STORE_ID and SSLC_STORE_PASSWORD (sandbox) in .env. Never prints the password.

if (process.env.SSLC_IS_LIVE === "true") {
  console.error("Refusing to run: SSLC_IS_LIVE is true. This script only talks to the sandbox.");
  process.exit(1);
}

const storeId = process.env.SSLC_STORE_ID;
const storePassword = process.env.SSLC_STORE_PASSWORD;
if (!storeId || !storePassword) {
  console.error("Set SSLC_STORE_ID and SSLC_STORE_PASSWORD (sandbox) in .env first.");
  process.exit(1);
}

// Imported after the live check so a live flag fails with the message above.
const { createSslcommerzGateway } = await import("../src/lib/sslcommerz.js");

const apiUrl = process.env.API_PUBLIC_URL ?? "http://localhost:4000";
const gateway = createSslcommerzGateway({ storeId, storePassword, isLive: false });
const tranId = `smoke-${Date.now()}`;

try {
  const session = await gateway.createSession({
    tranId,
    totalAmount: "10.00",
    productName: "Placement fee (smoke test)",
    customer: {
      name: "Smoke Test",
      email: "smoke@example.com",
      phone: "01700000000",
      city: "Dhaka",
    },
    urls: {
      success: `${apiUrl}/api/v1/payments/sslcommerz/success`,
      fail: `${apiUrl}/api/v1/payments/sslcommerz/fail`,
      cancel: `${apiUrl}/api/v1/payments/sslcommerz/cancel`,
      ipn: `${apiUrl}/api/v1/payments/sslcommerz/ipn`,
    },
  });
  console.log(`tranId: ${tranId}`);
  console.log(`GatewayPageURL: ${session.gatewayUrl}`);

  const found = await gateway.queryByTranId(tranId);
  console.log(`queryByTranId: ${found.length} transaction(s)`);
  console.log(JSON.stringify(found, null, 2));
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
}
