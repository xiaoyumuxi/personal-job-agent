export type ErrorKind = "AUTH_REQUIRED" | "TRANSIENT" | "PERMANENT" | "UNKNOWN";
export class AgentError extends Error {
  constructor(
    public kind: ErrorKind,
    public code: string,
    public uncertain = false,
  ) {
    super(code);
    this.name = "AgentError";
  }
}
export function classify(e: unknown): AgentError {
  if (e instanceof AgentError) return e;
  const err = e as { code?: string; message?: string; name?: string };
  if (
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "ECONNREFUSED",
      "EAI_AGAIN",
    ].includes(err?.code ?? "") ||
    /net::ERR_(CONNECTION|NAME_NOT_RESOLVED|NETWORK|TIMED_OUT)/.test(
      err?.message ?? "",
    )
  )
    return new AgentError("TRANSIENT", "NETWORK_UNAVAILABLE");
  return new AgentError("PERMANENT", "LOCAL_OR_ADAPTER_ERROR");
}
export function failureState(
  e: AgentError,
  failures: number,
  maxRetries: number,
) {
  if (e.kind === "AUTH_REQUIRED")
    return {
      status: "AUTH_REQUIRED",
      failures,
      retries: Math.max(0, failures - 1),
    };
  const n = failures + 1;
  return {
    status:
      e.kind !== "TRANSIENT"
        ? "STOPPED"
        : n > maxRetries
          ? "RETRY_EXHAUSTED"
          : "RETRY_PENDING",
    failures: n,
    retries: Math.max(0, n - 1),
  };
}
export const delay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
