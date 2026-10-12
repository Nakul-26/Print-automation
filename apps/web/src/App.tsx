import { Link, Route, Routes, useLocation } from 'react-router';
import { Footer } from './components/Footer';
import { AdminPage } from './pages/admin/AdminPage';
import { ApplyPage } from './pages/ApplyPage';
import { HomePage } from './pages/HomePage';
import { OwnerHome } from './pages/owner/OwnerHome';
import { QueuePage } from './pages/owner/QueuePage';
import { OrderPage } from './pages/OrderPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { ShopPage } from './pages/ShopPage';

export function App() {
  const { pathname } = useLocation();
  // Students see the privacy note; the shop's own pages stay uncluttered.
  const showFooter =
    !pathname.startsWith('/owner') && !pathname.startsWith('/admin') && pathname !== '/privacy';
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/s/:slug" element={<ShopPage />} />
        <Route path="/s/:slug/order/:token" element={<OrderPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/apply" element={<ApplyPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/owner" element={<OwnerHome />} />
        <Route path="/owner/:shopId" element={<QueuePage />} />
        <Route
          path="*"
          element={
            <main className="mx-auto w-full max-w-md px-4 py-16">
              <h1 className="display text-3xl">Page not found</h1>
              <p className="mt-3 text-muted">That link does not lead anywhere.</p>
              <Link to="/" className="mt-4 inline-block font-medium text-cyan underline">
                Back to start
              </Link>
            </main>
          }
        />
      </Routes>
      {showFooter && <Footer />}
    </>
  );
}
