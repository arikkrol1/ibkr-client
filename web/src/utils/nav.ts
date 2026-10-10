/** The app's tabs: shared by the desktop top nav and the mobile bottom bar. */
export interface NavTab {
  path: string;
  label: string;
  /** Fits a sixth of a phone's width in the bottom bar. */
  short: string;
}

export const NAV_TABS: readonly NavTab[] = [
  { path: "/", label: "Dashboard", short: "Home" },
  { path: "/pnl", label: "P&L", short: "P&L" },
  { path: "/activity", label: "Activity", short: "Activity" },
  { path: "/compare", label: "Compare", short: "Compare" },
  { path: "/chart", label: "Charts", short: "Charts" },
  { path: "/sectors", label: "Sectors", short: "Sectors" },
];
