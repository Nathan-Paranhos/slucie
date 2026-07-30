/**
 * Next.js substitutes NODE_ENV while creating a production bundle. Keep the
 * dashboard's authentication policy on an explicit runtime variable instead
 * so a development Compose overlay stays development after a production build.
 */
export function isProductionRuntime() {
  const key = "SLUICE_RUNTIME_ENV";
  const configured = process.env[key]?.trim().toLowerCase();

  if (configured === "development") return false;
  if (configured === "production") return true;

  // An omitted or invalid value must fail closed in a production build.
  return process.env.NODE_ENV === "production";
}
