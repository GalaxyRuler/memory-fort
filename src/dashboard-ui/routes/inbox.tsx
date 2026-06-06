import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "../components/InboxPage.js";

export const Route = createFileRoute("/inbox")({
  component: InboxPage,
});
