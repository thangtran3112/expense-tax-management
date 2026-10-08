export function isAllowedEmail(email, allowedEmailsCsv) {
  const allowed = new Set(
    (allowedEmailsCsv || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (typeof email !== "string") return false;
  return allowed.has(email.toLowerCase());
}
