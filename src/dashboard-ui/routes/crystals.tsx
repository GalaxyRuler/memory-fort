import { createFileRoute } from "@tanstack/react-router";
import { CrystalsPage } from "../components/CrystalsPage.js";

export const Route = createFileRoute("/crystals")({
  component: CrystalsPage,
});
