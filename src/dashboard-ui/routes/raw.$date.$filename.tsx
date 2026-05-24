import { createFileRoute } from "@tanstack/react-router";
import { RawSessionDetail } from "../components/RawSessionDetail.js";

export const Route = createFileRoute("/raw/$date/$filename")({
  component: RawSessionDetail,
});
