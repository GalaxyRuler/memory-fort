import {
  Activity as ActivityIcon,
  BookOpen,
  FileText,
  Gem,
  GitMerge,
  History,
  Home,
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
  { to: "/sessions", label: "Sessions", icon: Layers },
  { to: "/crystals", label: "Crystals", icon: Gem },
  { to: "/audit", label: "Audit", icon: Shield },
  { to: "/compile", label: "Compile", icon: Play },
  { to: "/conflicts", label: "Conflict Resolution", icon: GitMerge },
  { to: "/maintenance", label: "Maintenance", icon: Wrench },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.inMobileNav);
