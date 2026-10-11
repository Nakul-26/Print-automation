import { useEffect, useState } from 'react';
import { HealthResponse } from '@print/contracts';

type ApiState = 'checking' | 'online' | 'offline';

export function App() {
  const [api, setApi] = useState<ApiState>('checking');

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json())
      .then((body) => setApi(HealthResponse.safeParse(body).success ? 'online' : 'offline'))
      .catch(() => setApi('offline'));
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">Print Platform</h1>
      <p className="text-slate-600">Foundation build. API status: {api}</p>
    </main>
  );
}
