import { Routes, Route, Navigate } from "react-router-dom"
import { useAuth } from "@/AuthContext"
import { Layout } from "@/components/Layout"
import LoginPage from "@/pages/LoginPage"
import DashboardPage from "@/pages/DashboardPage"
import VendorsPage from "@/pages/VendorsPage"
import DestinationsPage from "@/pages/DestinationsPage"
import ItemsPage from "@/pages/ItemsPage"
import InvoicesPage from "@/pages/InvoicesPage"
import InvoiceDetailPage from "@/pages/InvoiceDetailPage"
import ReceiptsPage from "@/pages/ReceiptsPage"
import ReceiptDetailPage from "@/pages/ReceiptDetailPage"
import PurchasesPage from "@/pages/PurchasesPage"

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <Layout>{children}</Layout>
}

export default function App() {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vendors"
        element={
          <ProtectedRoute>
            <VendorsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/destinations"
        element={
          <ProtectedRoute>
            <DestinationsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/items"
        element={
          <ProtectedRoute>
            <ItemsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices"
        element={
          <ProtectedRoute>
            <InvoicesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/invoices/:id"
        element={
          <ProtectedRoute>
            <InvoiceDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/receipts"
        element={
          <ProtectedRoute>
            <ReceiptsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/receipts/:id"
        element={
          <ProtectedRoute>
            <ReceiptDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/purchases"
        element={
          <ProtectedRoute>
            <PurchasesPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}
