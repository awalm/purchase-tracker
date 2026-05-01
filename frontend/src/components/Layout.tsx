import { NavLink, useLocation } from "react-router-dom"
import { useEffect } from "react"
import { useAuth } from "@/AuthContext"
import {
  LayoutDashboard,
  Store,
  MapPin,
  Package,
  FileText,
  ShoppingCart,
  Receipt,
  LogOut,
  Settings,
  BarChart3,
  Car,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/receipts", icon: Receipt, label: "Receipts" },
  { to: "/invoices", icon: FileText, label: "Invoices" },
  { to: "/purchases", icon: ShoppingCart, label: "Purchases" },
  { to: "/items", icon: Package, label: "Items" },
  { to: "/vendors", icon: Store, label: "Vendors" },
  { to: "/destinations", icon: MapPin, label: "Destinations" },
  {
    to: "/reports/unreconciled",
    icon: BarChart3,
    label: "Reports",
    children: [
      { to: "/reports/unreconciled", label: "Unreconciled" },
      { to: "/reports/tax", label: "Tax Report" },
    ],
  },
  {
    to: "/services/travel/log",
    icon: Car,
    label: "Travel",
    children: [
      { to: "/services/travel/log", label: "Mileage Log" },
      { to: "/services/travel/import/google-timeline", label: "Timeline Import" },
      { to: "/services/travel/import/receipt", label: "Receipt Import" },
      { to: "/services/travel/locations", label: "Locations" },
    ],
  },
  { to: "/options", icon: Settings, label: "Options" },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()

  useEffect(() => {
    const path = location.pathname
    let title = "BG Tracker"
    if (path === "/") title = "Dashboard — BG Tracker"
    else if (path === "/receipts") title = "Receipts — BG Tracker"
    else if (path.startsWith("/receipts/")) title = "Receipt — BG Tracker"
    else if (path === "/invoices") title = "Invoices — BG Tracker"
    else if (path.startsWith("/invoices/")) title = "Invoice — BG Tracker"
    else if (path === "/purchases") title = "Purchases — BG Tracker"
    else if (path === "/items") title = "Items — BG Tracker"
    else if (path.startsWith("/items/")) title = "Item — BG Tracker"
    else if (path === "/vendors") title = "Vendors — BG Tracker"
    else if (path.startsWith("/vendors/")) title = "Vendor — BG Tracker"
    else if (path === "/destinations") title = "Destinations — BG Tracker"
    else if (path === "/reports/unreconciled") title = "Unreconciled — BG Tracker"
    else if (path === "/reports/tax") title = "Tax Report — BG Tracker"
    else if (path === "/services/travel/log") title = "Mileage Log — BG Tracker"
    else if (path === "/services/travel/import/google-timeline") title = "Timeline Import — BG Tracker"
    else if (path === "/services/travel/import/receipt") title = "Receipt Import — BG Tracker"
    else if (path === "/services/travel/locations") title = "Travel Locations — BG Tracker"
    else if (path === "/options") title = "Options — BG Tracker"
    document.title = title
  }, [location.pathname])

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-900 text-white flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-lg font-bold">BG Tracker</h1>
        </div>

        <nav className="flex-1 py-4">
          {navItems.map((item) => {
            const isSectionActive = item.children && (
              location.pathname.startsWith("/reports") && item.to.startsWith("/reports") ||
              location.pathname.startsWith("/services/travel") && item.to.startsWith("/services/travel")
            )
            return (
              <div key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 px-4 py-2 text-sm transition-colors",
                      isActive || isSectionActive
                        ? "bg-slate-800 text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
                {item.children && isSectionActive && (
                  <div className="ml-7 border-l border-slate-700">
                    {item.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        className={({ isActive }) =>
                          cn(
                            "block px-4 py-1.5 text-xs transition-colors",
                            isActive
                              ? "text-white"
                              : "text-slate-500 hover:text-slate-300"
                          )
                        }
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <p className="text-sm text-slate-400 mb-2">{user?.username}</p>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-red-400 hover:text-red-300 hover:bg-slate-800"
            onClick={logout}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 bg-slate-50 p-6 overflow-auto">{children}</main>
    </div>
  )
}
