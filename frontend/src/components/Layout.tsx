import { NavLink } from "react-router-dom"
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
]

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-900 text-white flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-lg font-bold">BG Tracker</h1>
        </div>

        <nav className="flex-1 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-4 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-white"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
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
