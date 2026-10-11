import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig GitHub host resolution", () => {
  it("defaults the OAuth host to github.com, so existing deployments are unaffected", () => {
    const config = loadConfig({});
    expect(config.githubBaseUrl).toBe("https://github.com");
    expect(config.githubApiUrl).toBe("https://api.github.com");
  });

  it("reads GITHUB_BASE_URL independently of GITHUB_API_URL", () => {
    // GitHub Enterprise Server splits these: the REST API lives under
    // /api/v3 while the OAuth routes stay on the bare host. A single value
    // cannot serve both, which is why this is a separate setting rather than
    // something derived from githubApiUrl.
    const config = loadConfig({
      GITHUB_API_URL: "https://ghe.example.com/api/v3",
      GITHUB_BASE_URL: "https://ghe.example.com",
    });
    expect(config.githubApiUrl).toBe("https://ghe.example.com/api/v3");
    expect(config.githubBaseUrl).toBe("https://ghe.example.com");
  });

  it("does not infer the OAuth host from GITHUB_API_URL", () => {
    // Setting only the API URL leaves the OAuth host at its default. Guessing
    // (e.g. stripping "/api/v3") would silently send a GHES deployment's users
    // to a host nobody configured, and it cannot be right for both GHES and
    // the github.com/api.github.com split.
    const config = loadConfig({ GITHUB_API_URL: "https://ghe.example.com/api/v3" });
    expect(config.githubBaseUrl).toBe("https://github.com");
  });
});
