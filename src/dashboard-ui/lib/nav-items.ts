import {
  Activity as ActivityIcon,
  BookOpen,
  FileText,
  Gem,
  GitMerge,
  History,
  Home,
  Inbox,
  Layers,
  Network,
  Play,
  Search,
  Settings as SettingsIcon,
  Shield,
  type LucideIcon,
  Wrench,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  inMobileNav?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", icon: Home, inMobileNav: true },
  { to: "/search", label: "Search", icon: Search, inMobileNav: true },
  { to: "/wiki", label: "Wiki", icon: BookOpen, inMobileNav: true },
  { to: "/raw", label: "Raw", icon: FileText },
  { to: "/graph", label: "Graph", icon: Network, inMobileNav: true },
  { to: "/timeline", label: "Timeline", icon: History, inMobileNav: true },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/sessions", label: "Sessions", icon: Layers },
  { to: "/crystals", label: "Crystals", icon: Gem },
  { to: "/audit", label: "Audit", icon: Shield },
  { to: "/compile", label: "Compile", icon: Play },
  { to: "/conflicts", label: "Conflict Resolution", icon: GitMerge },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const PRIMARY_NAV_LABELS = ["Overview", "Search", "Wiki", "Graph", "Settings"];
const OPERATIONS_NAV_LABELS = [
  "Raw",
  "Timeline",
  "Activity",
  "Sessions",
  "Inbox",
  "Audit",
  "Compile",
  "Maintenance",
];
const ADVANCED_NAV_LABELS = ["Crystals", "Conflict Resolution"];

export const PRIMARY_NAV_ITEMS = navItemsForLabels(PRIMARY_NAV_LABELS);
export const OPERATIONS_NAV_ITEMS = navItemsForLabels(OPERATIONS_NAV_LABELS);
export const ADVANCED_NAV_ITEMS = navItemsForLabels(ADVANCED_NAV_LABELS);
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.inMobileNav);

function navItemsForLabels(labels: string[]): NavItem[] {
  return labels.map((label) => {
    const item = NAV_ITEMS.find((candidate) => candidate.label === label);
    if (!item) throw new Error(`Unknown dashboard navigation item: ${label}`);
    return item;
  });
}
