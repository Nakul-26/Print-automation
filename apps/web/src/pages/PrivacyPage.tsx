import { useEffect } from 'react';
import { Link } from 'react-router';

/** Plain-language privacy notice. The one-day retention here must match RETENTION_HOURS on the server. */
export function PrivacyPage() {
  useEffect(() => {
    document.title = 'Privacy · Print';
  }, []);

  return (
    <main className="mx-auto w-full max-w-xl px-4 pb-16 pt-8 sm:pt-12">
      <p className="font-mono text-xs uppercase tracking-wide text-muted">Privacy</p>
      <h1 className="display mt-1 text-3xl sm:text-4xl">What happens to your files</h1>

      <div className="mt-6 space-y-6 leading-relaxed">
        <section>
          <h2 className="font-semibold">Deleted after one day</h2>
          <p className="mt-1 text-muted">
            Your documents and the print-ready copies we make from them are deleted 24 hours after
            you place the order, whether or not they were printed. If you upload a file but never
            place an order, it is deleted after the same time. You can remove a file yourself at any
            point before ordering with the Remove button, and it is deleted straight away.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">Who can see them</h2>
          <p className="mt-1 text-muted">
            Only the print shop you send the order to, and only to print it. We do not read, sell or
            share your documents. Files are stored on the service&apos;s own server, not with an
            advertising or analytics company.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">What we keep</h2>
          <p className="mt-1 text-muted">
            After the files are gone, the shop keeps a record of the order: the queue number, the
            name you typed (if any), the print settings, the price, and the time. There is no
            account and we do not ask for your email or phone number.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">Technical data</h2>
          <p className="mt-1 text-muted">
            To stop abuse, the server briefly uses your network address to limit how many requests
            one connection can make. Students are not given cookies or tracked across sites. Your
            order link is a secret: anyone who has it can see that order&apos;s status, so do not
            share it. If the shop turns on a bot check, it is run by Cloudflare Turnstile.
          </p>
        </section>

        <section>
          <h2 className="font-semibold">Questions or removal</h2>
          <p className="mt-1 text-muted">
            Ask the shop where you placed the order. Their contact details are at the top of the
            order page.
          </p>
        </section>
      </div>

      <p className="mt-10">
        <Link to="/" className="font-medium text-cyan underline">
          Back to start
        </Link>
      </p>
    </main>
  );
}
