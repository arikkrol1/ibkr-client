import { NavLink, Route, Routes } from "react-router-dom";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { GatewayMenu } from "./components/GatewayControls";
import { ActivityPage } from "./pages/ActivityPage";
import { ChartPage } from "./pages/ChartPage";
import { ComparePage } from "./pages/ComparePage";
import { DashboardPage } from "./pages/DashboardPage";
import { PnLPage } from "./pages/PnLPage";
import { SectorsPage } from "./pages/SectorsPage";
import { NAV_TABS } from "./utils/nav";

export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-6 border-b border-gray-800 bg-[#0b0e11] px-4 py-3 mobile:gap-3 mobile:px-3 mobile:py-2 mobile:pt-[max(0.5rem,env(safe-area-inset-top))]">
        <span className="text-lg font-semibold tracking-tight mobile:text-base">
          IBKR<span className="text-emerald-400">·</span>Client
        </span>
        <nav className="flex gap-1 mobile:hidden">
          {NAV_TABS.map((t) => (
            <Tab key={t.path} to={t.path}>
              {t.label}
            </Tab>
          ))}
        </nav>
        <GatewayMenu />
      </header>
      <ConnectionBanner />
      <main className="flex-1 p-4 mobile:overflow-x-clip mobile:p-3 mobile:pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/pnl" element={<PnLPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route path="/sectors" element={<SectorsPage />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}

function Tab({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          isActive
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/** Mobile only: thumb-reachable tab bar pinned to the bottom of the screen. */
function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 hidden border-t border-gray-800 bg-[#0b0e11]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur mobile:flex">
      {NAV_TABS.map((t) => (
        <NavLink
          key={t.path}
          to={t.path}
          end={t.path === "/"}
          className={({ isActive }) =>
            `flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${
              isActive ? "text-white" : "text-gray-500"
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={`h-1 w-6 rounded-full ${isActive ? "bg-emerald-400" : "bg-transparent"}`} />
              {t.short}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
