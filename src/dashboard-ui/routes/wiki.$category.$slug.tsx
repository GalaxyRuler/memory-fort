import { createFileRoute } from "@tanstack/react-router";
import { WikiPageDetail } from "../components/WikiPageDetail.js";

export const Route = createFileRoute("/wiki/$category/$slug")({
  component: WikiPageDetail,
});
