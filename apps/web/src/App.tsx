import { Link, Route, Routes } from 'react-router';
import { HomePage } from './pages/HomePage';
import { OwnerHome } from './pages/owner/OwnerHome';
import { QueuePage } from './pages/owner/QueuePage';
import { OrderPage } from './pages/OrderPage';
import { ShopPage } from './pages/ShopPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/s/:slug" element={<ShopPage />} />
      <Route path="/s/:slug/order/:token" element={<OrderPage />} />
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
  );
}
