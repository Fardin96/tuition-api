// Side-effect module: lets BigInt columns (e.g. AuditLog.id) serialise through JSON.stringify and res.send.
(BigInt.prototype as unknown as { toJSON: (this: bigint) => string }).toJSON = function (
  this: bigint,
) {
  return this.toString();
};
