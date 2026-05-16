import { describe, expect, it } from "vitest";
import { redactSecrets } from "../redact.js";

describe("redactSecrets", () => {
  it("redacts known key fields and secret-looking strings", () => {
    const result = redactSecrets({
      gtApiKey: "gt_live_very_secret",
      nested: {
        message: "Bearer sk-abc123456789999"
      },
      safe: "visible"
    });

    expect(result).toEqual({
      gtApiKey: "[REDACTED]",
      nested: { message: "[REDACTED]" },
      safe: "visible"
    });
  });
});
