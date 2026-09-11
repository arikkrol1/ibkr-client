import { NavLink, Route, Routes } from "react-router-dom";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ChartPage } from "./pages/ChartPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PnLPage } from "./pages/PnLPage";

export default function App() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-6 border-b border-gray-800 bg-[#0b0e11] px-4 py-3">
        <span className="text-lg font-semibold tracking-tight">
          IBKR<span className="text-emerald-400">·</span>Client
        </span>
        <nav className="flex gap-1">
          <Tab to="/">Dashboard</Tab>
          <Tab to="/pnl">P&L</Tab>
          <Tab to="/chart">Charts</Tab>
        </nav>
      </header>
      <ConnectionBanner />
      <main className="flex-1 p-4">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/pnl" element={<PnLPage />} />
          <Route path="/chart" element={<ChartPage />} />
        </Routes>
      </main>
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
