import { describe, expect, it, vi } from "vitest";
import {
  asArray,
  decodeResumeAsync,
  JazzHRDriver,
  looksLikeText,
  renderApplicant,
} from "./jazzhr.js";
import { PermanentError, PermissionDeniedError, TransientError } from "./types.js";
import type { FetchLike } from "./confluence.js";

const API_ORIGIN = "https://jazz.test/v1";
const CREDS = { service: "key-abc" };

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    // Real fetch exposes a Headers; a plain record is enough for retryAfterMs.
    ...(Object.keys(headers).length ? { headers } : {}),
  } as Awaited<ReturnType<FetchLike>>;
}

function bytesResponse(bytes: Uint8Array, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as Awaited<ReturnType<FetchLike>>;
}

/** A fetch double that routes on URL substring. Each entry is tried in order. */
function router(routes: [test: (url: string) => boolean, reply: (url: string) => Awaited<ReturnType<FetchLike>>][]): FetchLike {
  return vi.fn(async (url: string) => {
    for (const [test, reply] of routes) {
      if (test(url)) return reply(url);
    }
    throw new Error(`no route for ${url}`);
  }) as unknown as FetchLike;
}

const driver = (http: FetchLike, opts = {}) =>
  new JazzHRDriver({ fetch: http, apiOrigin: API_ORIGIN, sleep: async () => {}, ...opts });

describe("scope validation", () => {
  const d = driver(vi.fn());

  it("requires exactly one of jobID or all", () => {
    expect(() => d.validateScope({})).toThrow(/exactly one of scope.jobID or scope.all/);
    expect(() => d.validateScope({ jobID: "J1", all: true })).toThrow(/exactly one/);
  });

  it("accepts a named job or the wildcard", () => {
    expect(() => d.validateScope({ jobID: "J1" })).not.toThrow();
    expect(() => d.validateScope({ all: true })).not.toThrow();
  });

  it("rejects another provider's unit", () => {
    expect(() => d.validateScope({ jobID: "J1", folderID: "F1" })).toThrow(/nothing else/);
  });

  it("rejects a job id that could smuggle path syntax", () => {
    expect(() => d.validateScope({ jobID: "../../jobs" })).toThrow(/illegal/);
    expect(() => d.validateScope({ jobID: "J1/page/2" })).toThrow(/illegal/);
  });
});

describe("probe granularity", () => {
  it("is per connection — JazzHR has no per-candidate ACL", () => {
    expect(driver(vi.fn()).probeGranularity()).toBe("connection");
  });
});

describe("auth and WAF", () => {
  it("sends the key in BOTH apikey and api_key, with an explicit User-Agent", async () => {
    const http = vi.fn(async () => respond([])) as unknown as FetchLike;
    await driver(http).list({ jobID: "J1" }, CREDS, undefined);
    const [url, init] = (http as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("apikey=key-abc");
    expect(url).toContain("api_key=key-abc");
    expect((init as { headers: Record<string, string> }).headers["User-Agent"]).toBeTruthy();
  });
});

describe("list — single job", () => {
  it("paginates applicants2jobs by path segment and de-dupes applicants", async () => {
    // Page 1 full (100 rows, with a duplicate id), page 2 short → terminates.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ applicant_id: `A${i}`, first_name: "F", last_name: `${i}` }));
    page1[99] = { applicant_id: "A0", first_name: "F", last_name: "dup" }; // duplicate of A0
    const http = router([
      [(u) => u.includes("/applicants2jobs/job_id/J1/page/2"), () => respond([{ applicant_id: "A100" }])],
      [(u) => u.includes("/applicants2jobs/job_id/J1"), () => respond(page1)],
    ]);
    const { resources, cursor } = await driver(http).list({ jobID: "J1" }, CREDS, undefined);
    expect(cursor).toBeUndefined(); // JazzHR lists are non-incremental
    // 100 rows with one duplicate (A0 twice) + 1 on page 2 = 100 unique ids.
    expect(resources).toHaveLength(100);
    expect(new Set(resources.map((r) => r.id)).size).toBe(100);
    expect(resources[0]).toMatchObject({ id: "A0", title: "F 0" });
  });

  it("normalizes a one-item listing returned as a bare object", async () => {
    const http = router([[(u) => u.includes("/applicants2jobs/job_id/J1"), () => respond({ applicant_id: "A7" })]]);
    const { resources } = await driver(http).list({ jobID: "J1" }, CREDS, undefined);
    expect(resources.map((r) => r.id)).toEqual(["A7"]);
  });
});

describe("list — wildcard", () => {
  it("capped: lists exactly the Connection's allowed jobs, never /jobs", async () => {
    const http = router([
      [(u) => u.includes("/jobs"), () => { throw new Error("must not enumerate /jobs when capped"); }],
      [(u) => u.includes("/applicants2jobs/job_id/J1"), () => respond([{ applicant_id: "A1" }])],
      [(u) => u.includes("/applicants2jobs/job_id/J2"), () => respond([{ applicant_id: "A2" }])],
    ]);
    const { resources } = await driver(http).list({ all: true, allowedUnits: ["J1", "J2"] }, CREDS, undefined);
    expect(resources.map((r) => r.id).sort()).toEqual(["A1", "A2"]);
  });

  it("uncapped: enumerates /jobs then lists each", async () => {
    const http = router([
      [(u) => u.includes("/jobs"), () => respond([{ id: "J1" }, { id: "J2" }])],
      [(u) => u.includes("/applicants2jobs/job_id/J1"), () => respond([{ applicant_id: "A1" }])],
      [(u) => u.includes("/applicants2jobs/job_id/J2"), () => respond([{ applicant_id: "A1" }, { applicant_id: "A2" }])],
    ]);
    const { resources } = await driver(http).list({ all: true }, CREDS, undefined);
    // A1 appears in both jobs → de-duped across the wildcard.
    expect(resources.map((r) => r.id).sort()).toEqual(["A1", "A2"]);
  });
});

describe("fetch — rendering", () => {
  it("renders profile, questionnaire and inline resume to markdown", async () => {
    const applicant = {
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      apply_date: "2026-01-02",
      linkedin_url: "https://linkedin.com/in/ada",
      prospect_int_id: "P9",
      resume_body: "Experienced analytical engine programmer.",
      questionnaire: [{ question: "Years of experience?", answer: "10" }],
    };
    const http = router([[(u) => u.includes("/applicants/A1"), () => respond(applicant)]]);
    const doc = await driver(http).fetch({ jobID: "J1" }, CREDS, "A1");
    expect(doc.title).toBe("Ada Lovelace");
    expect(doc.url).toContain("/candidate/P9/profile");
    expect(doc.acl).toEqual({ principals: [], permissive: true });
    expect(doc.markdown).toContain("# Ada Lovelace");
    expect(doc.markdown).toContain("ada@example.com");
    expect(doc.markdown).toContain("## Questionnaire");
    expect(doc.markdown).toContain("Years of experience?");
    expect(doc.markdown).toContain("## Resume");
    expect(doc.markdown).toContain("analytical engine");
  });

  it("falls back to a resume FILE when the profile has no inline resume", async () => {
    const resumeText = "Senior platform engineer, Kubernetes, Go.";
    const http = router([
      [(u) => u.includes("/applicants/A2"), () => respond({ first_name: "Grace", last_name: "H" })],
      [
        (u) => u.includes("/files/applicant_id/A2"),
        () => respond({ id: "F1", file_name: "grace-resume.txt", content_type: "application/octet-stream", file_data: Buffer.from(resumeText).toString("base64") }),
      ],
    ]);
    const doc = await driver(http).fetch({ jobID: "J1" }, CREDS, "A2");
    expect(doc.markdown).toContain("## Resume");
    expect(doc.markdown).toContain("Senior platform engineer");
  });

  it("downloads the raw file when the record carries only a url", async () => {
    const resumeText = "Downloaded resume body.";
    const http = router([
      [(u) => u.includes("/applicants/A3"), () => respond({ first_name: "Guido" })],
      [(u) => u.includes("/files/applicant_id/A3"), () => respond([{ id: "F1", file_name: "cv.txt", file_url: "https://files.test/cv" }])],
      [(u) => u === "https://files.test/cv", () => bytesResponse(new Uint8Array(Buffer.from(resumeText)))],
    ]);
    const doc = await driver(http).fetch({ jobID: "J1" }, CREDS, "A3");
    expect(doc.markdown).toContain("Downloaded resume body.");
  });

  it("omits the resume section when there is none", async () => {
    const http = router([
      [(u) => u.includes("/applicants/A4"), () => respond({ first_name: "Alan" })],
      [(u) => u.includes("/files/applicant_id/A4"), () => respond([])],
    ]);
    const doc = await driver(http).fetch({ jobID: "J1" }, CREDS, "A4");
    expect(doc.markdown).not.toContain("## Resume");
  });
});

describe("rate limiting and error classification", () => {
  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    const http = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? respond("slow down", 429, { "retry-after": "0" }) : respond([{ applicant_id: "A1" }]);
    }) as unknown as FetchLike;
    const { resources } = await driver(http).list({ jobID: "J1" }, CREDS, undefined);
    expect(calls).toBe(2);
    expect(resources.map((r) => r.id)).toEqual(["A1"]);
  });

  it("maps 401/403 to PermissionDenied, 404 to Permanent, 5xx to Transient", async () => {
    const d401 = driver(router([[() => true, () => respond("Invalid API Key", 401)]]));
    await expect(d401.list({ jobID: "J1" }, CREDS, undefined)).rejects.toBeInstanceOf(PermissionDeniedError);

    const d404 = driver(router([[(u) => u.includes("/applicants/X"), () => respond("gone", 404)]]));
    await expect(d404.fetch({ jobID: "J1" }, CREDS, "X")).rejects.toBeInstanceOf(PermanentError);

    const d500 = driver(router([[() => true, () => respond("boom", 500)]]));
    await expect(d500.list({ jobID: "J1" }, CREDS, undefined)).rejects.toBeInstanceOf(TransientError);
  });

  it("requires a service credential", async () => {
    await expect(driver(vi.fn()).list({ jobID: "J1" }, {}, undefined)).rejects.toThrow(/api key/i);
  });
});

describe("pure helpers", () => {
  it("asArray tolerates arrays, bare objects, and array-wrapping objects", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ id: "x" })).toEqual([{ id: "x" }]);
    expect(asArray({ results: [1, 2] })).toEqual([1, 2]);
    expect(asArray("nope")).toEqual([]);
  });

  it("looksLikeText accepts printable UTF-8 and rejects binary", () => {
    expect(looksLikeText(new Uint8Array(Buffer.from("hello resume")))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
  });

  it("decodeResumeAsync reads plain text and a real DOCX zip", async () => {
    expect(await decodeResumeAsync(new Uint8Array(Buffer.from("plain text cv")), "application/octet-stream")).toBe("plain text cv");

    // A minimal DOCX is a zip with word/document.xml; build one with fflate.
    const { zipSync, strToU8 } = await import("fflate");
    const docx = zipSync({
      "word/document.xml": strToU8("<w:document><w:body><w:p><w:t>Docx resume text</w:t></w:p></w:body></w:document>"),
    });
    const text = await decodeResumeAsync(docx, "");
    expect(text).toContain("Docx resume text");
  });

  it("renderApplicant only emits sections that have content", () => {
    const md = renderApplicant("A1", { first_name: "Jo" }, "");
    expect(md).toContain("# Jo");
    expect(md).not.toContain("## Questionnaire");
    expect(md).not.toContain("## Resume");
  });
});
