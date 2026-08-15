export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function classifyError(e: unknown): { errorKind: string; retryable: boolean } {
  const s = errorMessage(e).toLowerCase();
  if (s.includes("insufficient_quota") || s.includes("billing hard limit") || s.includes("quota exceeded")) return { errorKind: "quota", retryable: false };
  if (s.includes("429") || s.includes("rate limit") || s.includes("too many requests")) return { errorKind: "rate_limit", retryable: true };
  if (s.includes(" 401") || s.includes(" 403") || s.includes("unauthorized") || s.includes("forbidden") || s.includes("invalid api key") || s.includes("api key")) return { errorKind: "auth", retryable: false };
  if (s.includes("timed out") || s.includes("timeout") || s.includes("etimedout")) return { errorKind: "timeout", retryable: true };
  if (
    (s.includes("team") && s.includes("budget"))
    || s.includes("team provider request cannot fit the provider's minimum output allowance")
  ) return { errorKind: "team_budget", retryable: false };
  if (s.includes("team provider request") || s.includes("team provider response")) {
    return { errorKind: "team_state", retryable: false };
  }
  if (s.includes("context") && (s.includes("length") || s.includes("window") || s.includes("maximum") || s.includes("too long") || s.includes("token"))) return { errorKind: "context", retryable: false };
  if (s.includes("econnrefused") || s.includes("enotfound") || s.includes("fetch failed") || s.includes("network") || s.includes("socket") || s.includes("connection error") || s.includes("econnreset")) return { errorKind: "network", retryable: true };
  if (s.includes("cyber_policy") || s.includes("flagged for possible cybersecurity") || s.includes("trusted access for cyber")) return { errorKind: "cyber_policy", retryable: true };
  if (s.includes("model_price_error") || s.includes("has not been priced") || s.includes("model not found") || s.includes("model_not_found")) return { errorKind: "provider_config", retryable: false };
  if (/error \(4\d\d\)|4\d\d status code/.test(s)) return { errorKind: "request", retryable: false };
  if (/error \(5\d\d\)|5\d\d status code/.test(s) || s.includes("bad gateway") || s.includes("service unavailable") || s.includes("internal server error") || s.includes("overloaded_error")) return { errorKind: "server", retryable: true };
  return { errorKind: "unknown", retryable: true };
}
