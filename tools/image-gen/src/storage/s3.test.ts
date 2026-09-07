import { describe, it, expect } from "vitest";
import { objectKey } from "./s3.js";

describe("objectKey", () => {
  it("builds a key under the default prefix", () => {
    // Default IMAGE_S3_PREFIX is "images" (see config.ts).
    expect(objectKey("job-123")).toBe("images/job-123.png");
  });

  it("honors a custom extension", () => {
    expect(objectKey("job-123", "jpg")).toBe("images/job-123.jpg");
  });
});
