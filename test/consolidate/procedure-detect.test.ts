import { describe, expect, it } from "vitest";
import {
  detectProcedureClusters,
  extractCommandSignature,
  type RawProcedureObservationRef,
} from "../../src/consolidate/procedure-detect.js";

describe("extractCommandSignature", () => {
  it("extracts ordered command names from shell fences and filters trivial commands", () => {
    const signature = extractCommandSignature([
      "```bash",
      "cd /root/memory-system",
      "npm run build",
      "scp dist/dashboard/server.mjs root@srv:/root/server.mjs",
      "ssh root@srv \"systemctl restart memory-dashboard\"",
      "curl -fsS https://example.test/memory/api/health",
      "```",
    ].join("\n"));

    expect(signature.commands).toEqual(["npm", "scp", "ssh", "curl"]);
    expect(signature.hasErrorIndicators).toBe(false);
  });

  it("extracts inline prompt commands and marks error indicators", () => {
    const signature = extractCommandSignature([
      "$ git status --short",
      "$ npm test",
      "FAIL test failed",
      "exit code 1",
      "$ curl -f http://localhost:4410/health",
    ].join("\n"));

    expect(signature.commands).toEqual(["git", "npm", "curl"]);
    expect(signature.hasErrorIndicators).toBe(true);
  });
});

describe("detectProcedureClusters", () => {
  it("clusters repeated command signatures across distinct sessions", () => {
    const clusters = detectProcedureClusters([
      obs("one", "s1", "```bash\nscp a b\nssh host restart\ncurl health\n```"),
      obs("two", "s2", "$ scp a b\n$ ssh host restart\n$ curl health"),
      obs("three", "s3", "```sh\nscp a b\nssh host restart\ncurl health\n```"),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.signature).toEqual(["scp", "ssh", "curl"]);
    expect(clusters[0]?.distinctSessions).toBe(3);
    expect(clusters[0]?.hasSuccessfulOutcome).toBe(true);
    expect(clusters[0]?.cohesionScore).toBe(1);
  });

  it("filters repeated signatures from only one session", () => {
    const clusters = detectProcedureClusters([
      obs("one", "same", "$ scp a b\n$ ssh host restart\n$ curl health"),
      obs("two", "same", "$ scp a b\n$ ssh host restart\n$ curl health"),
      obs("three", "same", "$ scp a b\n$ ssh host restart\n$ curl health"),
    ]);

    expect(clusters).toEqual([]);
  });

  it("does not cluster dissimilar command signatures", () => {
    const clusters = detectProcedureClusters([
      obs("one", "s1", "$ scp a b\n$ ssh host restart\n$ curl health"),
      obs("two", "s2", "$ git add .\n$ git commit -m x\n$ git push"),
      obs("three", "s3", "$ npm install openai\n$ node server.mjs\n$ curl health"),
    ]);

    expect(clusters).toEqual([]);
  });

  it("filters clusters with only failed observations", () => {
    const clusters = detectProcedureClusters([
      obs("one", "s1", "$ scp a b\n$ ssh host restart\n$ curl health\nfatal: failed"),
      obs("two", "s2", "$ scp a b\n$ ssh host restart\n$ curl health\nnpm ERR! nope"),
      obs("three", "s3", "$ scp a b\n$ ssh host restart\n$ curl health\nexit code 1"),
    ]);

    expect(clusters).toEqual([]);
  });

  it("keeps large clusters intact and leaves cost bounding to max proposals", () => {
    const clusters = detectProcedureClusters(
      Array.from({ length: 35 }, (_, index) =>
        obs(`item-${index}`, `s${index}`, "$ scp a b\n$ ssh host restart\n$ curl health")
      ),
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.observations).toHaveLength(35);
  });
});

function obs(name: string, session: string | null, body: string): RawProcedureObservationRef {
  return {
    relPath: `raw/2026-05-28/${name}.md`,
    created: "2026-05-28",
    session,
    source: "codex",
    title: name,
    body,
  };
}
