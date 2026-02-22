const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?<=api[_-]?key["'\s:=]{0,4})[A-Za-z0-9_\-]{10,}/gi,
  /(?<=token["'\s:=]{0,4})[A-Za-z0-9_\-]{12,}/gi
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED_SECRET]");
  }
  return result;
}
