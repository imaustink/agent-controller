import { describe, expect, it, vi } from "vitest";
import type { V1Job } from "@kubernetes/client-node";
import { K8sJobLauncher, type BatchV1ApiLike } from "./job-launcher.js";
import type { JobTemplate } from "../tool-descriptor.js";

const template: JobTemplate = {
  image: "example.com/tool:latest",
  namespace: "default",
  serviceAccountName: "tool-sa",
};

describe("K8sJobLauncher", () => {
  it("creates a hardened Job with the callback env vars injected", async () => {
    const createNamespacedJob = vi.fn().mockResolvedValue({} as V1Job);
    const batchApi: BatchV1ApiLike = {
      createNamespacedJob,
      readNamespacedJobStatus: vi.fn(),
      deleteNamespacedJob: vi.fn(),
    };
    const launcher = new K8sJobLauncher(batchApi);

    const launched = await launcher.launch(template, {
      args: ["do the thing"],
      callbackUrl: "http://orchestrator/callback/abc",
      callbackSecret: "s3cret",
    });

    expect(launched.namespace).toBe("default");
    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
    const [{ namespace, body }] = createNamespacedJob.mock.calls[0] as [{ namespace: string; body: V1Job }];
    expect(namespace).toBe("default");

    const container = body.spec?.template.spec?.containers[0];
    expect(container?.image).toBe("example.com/tool:latest");
    expect(container?.args).toEqual(["do the thing"]);
    expect(container?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(container?.env).toEqual(
      expect.arrayContaining([
        { name: "CALLBACK_URL", value: "http://orchestrator/callback/abc" },
        { name: "CALLBACK_SECRET", value: "s3cret" },
      ]),
    );
  });

  it("reads job status via the object-param API", async () => {
    const readNamespacedJobStatus = vi.fn().mockResolvedValue({ status: { succeeded: 1 } } as V1Job);
    const batchApi: BatchV1ApiLike = {
      createNamespacedJob: vi.fn(),
      readNamespacedJobStatus,
      deleteNamespacedJob: vi.fn(),
    };
    const launcher = new K8sJobLauncher(batchApi);

    const status = await launcher.getStatus({ name: "tool-123", namespace: "default" });

    expect(readNamespacedJobStatus).toHaveBeenCalledWith({ name: "tool-123", namespace: "default" });
    expect(status).toEqual({ succeeded: 1 });
  });
});
