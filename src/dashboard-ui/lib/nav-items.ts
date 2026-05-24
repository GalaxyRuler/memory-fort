import {
  Activity as ActivityIcon,
  BookOpen,
  FileText,
  Gem,
  History,
  Home,
  Layers,
  Network,
  Search,
  Settings as SettingsIcon,
  Shield,
  type LucideIcon,
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
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/timeline", label: "Timeline", icon: History },
  { to: "/activity", label: "Activity", icon: ActivityIcon, inMobileNav: true },
  { to: "/sessions", label: "Sessions", icon: Layers },
  { to: "/crystals", label: "Crystals", icon: Gem },
  { to: "/audit", label: "Audit", icon: Shield },
  { to: "/settings", label: "Settings", icon: SettingsIcon, inMobileNav: true },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.inMobileNav);
