import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";
import { WikiPageDetail } from "../components/WikiPageDetail.js";
import { parseIncludeArchivedQuery } from "../../search/contract.js";

export const Route = createFileRoute("/wiki/$category/$slug")({
  component: WikiPageDetail,
  validateSearch: (search: WikiPageDetailSearchInput): WikiPageDetailSearch => ({
    includeArchived: parseIncludeArchivedQuery(search.includeArchived) === true ? 1 : undefined,
  }),
});

export interface WikiPageDetailSearchInput extends SearchSchemaInput {
  includeArchived?: unknown;
}

export interface WikiPageDetailSearch {
  includeArchived?: 1;
}
