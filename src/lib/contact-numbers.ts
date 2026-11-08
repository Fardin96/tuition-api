import { prisma } from "./prisma.js";

type ContactNumbers = { phoneNumber?: string; whatsappNumber?: string };

async function isNumberUsedByOtherAccount(accountId: string, number: string) {
  const rows = await prisma.$queryRaw<{ taken: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM student WHERE account_id <> ${accountId}::uuid
              AND (phone_number = ${number} OR whatsapp_number = ${number}))
      OR EXISTS (SELECT 1 FROM tutor WHERE account_id <> ${accountId}::uuid
                 AND (phone_number = ${number} OR whatsapp_number = ${number}))
    ) AS taken`;
  return rows[0].taken;
}

export async function assertContactNumbersFree(accountId: string, numbers: ContactNumbers) {
  if (
    numbers.whatsappNumber &&
    (await isNumberUsedByOtherAccount(accountId, numbers.whatsappNumber))
  ) {
    throw Object.assign(new Error("This WhatsApp number is already in use."), {
      name: "WhatsappInUse",
      statusCode: 409,
    });
  }
  if (numbers.phoneNumber && (await isNumberUsedByOtherAccount(accountId, numbers.phoneNumber))) {
    throw Object.assign(new Error("This phone number is already in use."), {
      name: "PhoneInUse",
      statusCode: 409,
    });
  }
}

function isContactConflict(e: unknown) {
  if (!(e instanceof Error)) return false;
  const { code, meta } = e as Error & { code?: string; meta?: unknown };
  const text = `${e.message} ${JSON.stringify(meta ?? "")}`;
  if (text.includes("contact_number_in_use")) return true;
  return code === "P2002" && /contact_number_unique|phone_number|whatsapp_number/.test(text);
}

// Race backstop: the DB guard rejected a write that the pre-check let through.
// The conflicting row is committed by now, so re-checking names the field.
export async function mapContactNumberError(
  e: unknown,
  accountId: string,
  numbers: ContactNumbers,
): Promise<never> {
  if (!isContactConflict(e)) throw e;
  await assertContactNumbersFree(accountId, numbers);
  throw e;
}
