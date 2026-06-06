import { computeGraphHealth } from "../../../dashboard/graph-health.js";
import { loadGraphFeed } from "../../../dashboard/loaders.js";
import { loadSearchCorpus } from "../../../retrieval/corpus.js";
import { isEntityWikiPath } from "../../../retrieval/wiki-paths.js";
import { fail, pass, warn, type CheckDescriptor } from "./types.js";

export const graphCohesionCheck: CheckDescriptor = {
  id: "graph.cohesion",
  label: "graph cohesion metrics",
  roles: ["operator", "server"],
  run: async (ctx) => {
    const [feed, corpus] = await Promise.all([
      loadGraphFeed(ctx.vaultRoot, "all"),
      loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "wiki" }),
    ]);
    const report = computeGraphHealth({
      feed,
      wikiPages: corpus.documents.filter((document) => isEntityWikiPath(document.relPath)),
    });

    if (report.overallStatus === "fail") {
      const failingIds = report.metrics
        .filter((metric) => metric.status === "fail")
        .map((metric) => metric.id)
        .join(", ");
      return fail(
        "graph.cohesion",
        `graph cohesion: ${failingIds} in fail`,
        "open the dashboard Graph Health panel",
        failingIds,
      );
    }

    if (report.overallStatus === "warn") {
      const warnIds = report.metrics
        .filter((metric) => metric.status === "warn")
        .map((metric) => metric.id);
      return warn(
        "graph.cohesion",
        `graph cohesion: ${warnIds.length} metric${warnIds.length === 1 ? "" : "s"} in warn`,
        warnIds.join(", "),
      );
    }

    return pass("graph.cohesion", "graph cohesion: all metrics passing");
  },
};
