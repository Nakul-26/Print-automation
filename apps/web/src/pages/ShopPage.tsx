import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { EstimateResponse, PublicShopInfo } from '@print/contracts';
import { FilesStep } from '../components/FilesStep';
import { ReviewStep } from '../components/ReviewStep';
import { SettingsStep } from '../components/SettingsStep';
import { Button, Notice, Spinner, Stepper } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useOrderDraft } from '../lib/draft';
import { formatRupees } from '../lib/format';

const STEPS = ['Files', 'Settings', 'Review'];

export function ShopPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();

  const [shop, setShop] = useState<PublicShopInfo | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);
  const draft = useOrderDraft(slug, shop);

  const [step, setStep] = useState(0);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [botToken, setBotToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getShop(slug)
      .then((info) => !cancelled && setShop(info))
      .catch((err: unknown) => {
        if (cancelled) return;
        setShopError(
          err instanceof ApiError && err.status === 404
            ? 'We could not find this shop. Check the link or scan the QR code again.'
            : err instanceof ApiError
              ? err.message
              : 'Could not load this shop.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (shop) document.title = `${shop.name} · Print`;
  }, [shop]);

  // Files that can appear in the settings step: converted, or being converted again after a change.
  const candidates = draft.items.filter(
    (i) =>
      i.token && (i.phase === 'ready' || (i.phase === 'processing' && i.upload?.pageCount != null)),
  );
  const ready = draft.ready;
  const converting = candidates.some((i) => i.phase === 'processing');

  // Keep the price in step with the settings.
  const estimateInput = useMemo(
    () =>
      JSON.stringify(
        ready.map((i) => ({
          uploadToken: i.token,
          settings: i.settings,
          rev: i.upload?.revision ?? 0,
        })),
      ),
    [ready],
  );
  useEffect(() => {
    if (!shop || step === 0 || ready.length === 0 || converting) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .estimate(slug, {
          items: ready.map((i) => ({ uploadToken: i.token!, settings: i.settings })),
        })
        .then((res) => {
          if (cancelled) return;
          setEstimate(res);
          setEstimateError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setEstimate(null);
          setEstimateError(err instanceof ApiError ? err.message : 'Could not work out the price.');
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // estimateInput captures every value the request depends on
  }, [shop, slug, step, estimateInput, converting]);

  // If every file is removed, go back to the start.
  useEffect(() => {
    if (step > 0 && draft.items.length === 0) setStep(0);
  }, [step, draft.items.length]);

  const estimates = useMemo(
    () => new Map((estimate?.items ?? []).map((i) => [i.uploadToken, i])),
    [estimate],
  );

  const onToken = useCallback((token: string | null) => setBotToken(token), []);

  const submit = async () => {
    if (!shop) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.createOrder(slug, {
        ...(name.trim() ? { customerName: name.trim() } : {}),
        items: ready.map((i) => ({ uploadToken: i.token!, settings: i.settings })),
        ...(botToken ? { turnstileToken: botToken } : {}),
      });
      draft.clear();
      navigate(`/s/${slug}/order/${created.lookupToken}`, {
        replace: true,
        state: { order: created.order },
      });
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Could not place the order. Please try again.',
      );
      setBotToken(null);
      setCaptchaNonce((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  if (shopError) {
    return (
      <Shell>
        <Notice tone="error">{shopError}</Notice>
        <Link to="/" className="mt-4 inline-block font-medium text-cyan underline">
          Back to start
        </Link>
      </Shell>
    );
  }
  if (!shop) {
    return (
      <Shell>
        <Spinner label="Opening shop" />
      </Shell>
    );
  }

  const cheapest = Math.min(...shop.rates.map((r) => r.pricePerSidePaise));
  const needsBotCheck = Boolean(shop.turnstileSiteKey);

  const primary = (() => {
    if (step === 0) {
      return {
        label: draft.busy ? 'Getting files ready…' : 'Continue',
        disabled: draft.busy || ready.length === 0,
        onClick: () => setStep(1),
      };
    }
    if (step === 1) {
      return {
        label: 'Review order',
        disabled: converting || !estimate || Boolean(estimateError),
        onClick: () => setStep(2),
      };
    }
    return {
      label: submitting ? 'Placing order…' : 'Get my queue number',
      disabled: submitting || !estimate || (needsBotCheck && !botToken),
      onClick: submit,
    };
  })();

  return (
    <Shell>
      <header className="mb-5">
        <p className="font-mono text-xs uppercase tracking-wide text-muted">Print order</p>
        <h1 className="display mt-1 text-3xl sm:text-4xl">{shop.name}</h1>
        <p className="mt-2 text-sm text-muted">
          {shop.rates.length > 0 ? `From ${formatRupees(cheapest)} per side. ` : ''}
          {shop.address ? `${shop.address}. ` : ''}
          {shop.contactPhone ?? ''}
        </p>
      </header>

      <div className="mb-5">
        <Stepper steps={STEPS} current={step} />
      </div>

      {shop.rates.length === 0 && (
        <Notice tone="error">
          This shop has not set its prices yet, so orders cannot be placed.
        </Notice>
      )}

      {step === 0 && (
        <FilesStep shop={shop} items={draft.items} onAdd={draft.addFiles} onRemove={draft.remove} />
      )}
      {step === 1 && (
        <SettingsStep
          shop={shop}
          items={candidates}
          estimates={estimates}
          estimateError={estimateError}
          onSettings={draft.updateSettings}
          onConversion={draft.changeConversion}
        />
      )}
      {step === 2 && (
        <ReviewStep
          shop={shop}
          items={ready}
          estimate={estimate}
          name={name}
          onName={setName}
          onToken={onToken}
          nonce={captchaNonce}
          error={submitError}
        />
      )}

      {/* Sticky action bar: the price and the next step are always in thumb's reach. */}
      <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-paper/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:mx-0 sm:rounded-b-card sm:px-0">
        <div className="flex items-center gap-3">
          {step > 0 && (
            <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={submitting}>
              Back
            </Button>
          )}
          {step > 0 && estimate && (
            <p className="min-w-0 flex-1 leading-tight">
              <span className="block font-mono text-[11px] uppercase tracking-wide text-muted">
                Estimate
              </span>
              <span className="display text-2xl">{formatRupees(estimate.totalPaise)}</span>
            </p>
          )}
          <Button
            className={step === 0 ? 'w-full' : 'ml-auto'}
            onClick={primary.onClick}
            disabled={primary.disabled}
          >
            {primary.label}
          </Button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-xl px-4 pb-6 pt-6 sm:pt-10">{children}</main>;
}
