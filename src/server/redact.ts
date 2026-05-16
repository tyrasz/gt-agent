const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{12,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g
];

const SECRET_KEY_PATTERN = /(api[-_ ]?key|authorization|providerkeys|gtapikey|token|secret)/i;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(nested)
      ])
    );
  }

  return value;
}

export function redactError(error: unknown): string {
  if (error instanceof Error) {
    return String(redactSecrets(error.message));
  }
  return String(redactSecrets(error));
}
