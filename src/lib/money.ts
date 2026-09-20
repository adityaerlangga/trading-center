export function parseMoney(value: string | number): number {
  if (typeof value === "number") return value;
  const trimmed = value.trim().replace(/\s/g, "");
  if (!trimmed) return Number.NaN;
  if (trimmed.includes(",") && trimmed.includes(".")) {
    return Number(trimmed.replace(/\./g, "").replace(",", "."));
  }
  if (/^\d{1,3}(\.\d{3})+$/.test(trimmed)) {
    return Number(trimmed.replace(/\./g, ""));
  }
  if (trimmed.includes(",") && !trimmed.includes(".")) {
    return Number(trimmed.replace(",", "."));
  }
  return Number(trimmed);
}
