import { createFileRoute } from "@tanstack/react-router";
import { CompilePage } from "../components/CompilePage.js";

export const Route = createFileRoute("/compile")({
  component: CompilePage,
});
