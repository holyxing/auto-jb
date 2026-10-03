export function apiError(status: number, payload: unknown): string {
  const detail = payload && typeof payload === "object"
    ? (payload as { detail?: unknown }).detail : undefined;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const invalid = detail.filter((item) => item && typeof item === "object") as Array<{
      type?: unknown; loc?: unknown; msg?: unknown;
    }>;
    const unsupported = invalid.find((item) => item.type === "extra_forbidden");
    if (unsupported) {
      const field = Array.isArray(unsupported.loc)
        ? unsupported.loc.filter((part): part is string => typeof part === "string").at(-1)
        : undefined;
      return `扩展与本机服务版本不一致${field ? `：服务不识别 ${field}` : ""}，请更新本机服务`;
    }
    const message = invalid.find((item) => typeof item.msg === "string")?.msg;
    if (typeof message === "string") return `请求参数无效（HTTP ${status}）：${message}`;
  }
  return `请求失败（HTTP ${status}），请检查本机服务和扩展版本`;
}
