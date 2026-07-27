function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim();
}

export function isSameOrigin(request: Request) {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  let suppliedOrigin: string;
  try {
    suppliedOrigin = new URL(originHeader).origin;
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  const trustProxy = process.env.DASHBOARD_TRUST_PROXY === "true";
  const host =
    (trustProxy
      ? firstHeaderValue(request.headers.get("x-forwarded-host"))
      : undefined) ??
    firstHeaderValue(request.headers.get("host"));
  const protocol =
    (trustProxy
      ? firstHeaderValue(request.headers.get("x-forwarded-proto"))
      : undefined) ?? requestUrl.protocol.replace(":", "");

  const accepted = new Set([requestUrl.origin]);
  if (
    host &&
    (protocol === "http" || protocol === "https") &&
    !/[\r\n/@\\]/.test(host)
  ) {
    try {
      accepted.add(new URL(`${protocol}://${host}`).origin);
    } catch {
      return false;
    }
  }

  return accepted.has(suppliedOrigin);
}
