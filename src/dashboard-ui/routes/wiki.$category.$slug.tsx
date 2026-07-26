import { createFileRoute } from "@tanstack/react-router";
import { WikiPageDetail } from "../components/WikiPageDetail.js";
import { canonicalIncludeArchivedQuery } from "../../search/contract.js";

export const Route = createFileRoute("/wiki/$category/$slug")({
  component: WikiPageDetail,
  validateSearch: (search): WikiPageDetailSearch => ({
    includeArchived: canonicalIncludeArchivedQuery(search.includeArchived),
  }),
});

export interface WikiPageDetailSearch {
  includeArchived?: "1";
}
