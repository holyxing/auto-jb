import { expect, it } from "vitest";
import { apiError } from "../../extension/src/httpError";

it("explains an extension/backend schema mismatch without showing request input", () => {
  const payload = { detail: [{
    type: "extra_forbidden", loc: ["body", "contact_interval_seconds"],
    msg: "Extra inputs are not permitted", input: "private-value",
  }] };
  expect(apiError(422, payload)).toContain("服务不识别 contact_interval_seconds");
  expect(apiError(422, payload)).not.toContain("private-value");
});

it("preserves server errors and reports other validation failures", () => {
  expect(apiError(401, { detail: "扩展未配对或已撤销" })).toBe("扩展未配对或已撤销");
  expect(apiError(422, { detail: [{ loc: ["body", "minutes"], msg: "Input should be less than 120" }] }))
    .toContain("Input should be less than 120");
  expect(apiError(500, {})).toContain("HTTP 500");
});
