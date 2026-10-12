import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Button } from '../ui';

/**
 * The shop's QR code: what students scan at the counter. Print it as a poster or save the image.
 * The code is drawn in the browser, so the shop's link never leaves the page.
 */
export function QrPanel({
  slug,
  name,
  onClose,
}: {
  slug: string;
  name: string;
  onClose: () => void;
}) {
  const link = `${window.location.origin}/s/${slug}`;
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (out) => !cancelled && setSvg(out),
    );
    return () => {
      cancelled = true;
    };
  }, [link]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const savePng = async () => {
    const url = await QRCode.toDataURL(link, { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-qr.png`;
    a.click();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Shop QR code"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-3 print:static print:block print:bg-white print:p-0"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-card bg-paper p-5 text-center print:max-w-none print:bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="display text-3xl print:text-6xl">{name}</p>
        <p className="mt-1 text-muted print:text-2xl print:text-ink">
          Scan to print without waiting
        </p>
        <div
          className="mx-auto my-4 aspect-square w-64 rounded-xl bg-white p-2 print:w-[70vw] [&>svg]:size-full"
          role="img"
          aria-label={`QR code for ${link}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="break-all font-mono text-sm print:text-xl">{link}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3 print:hidden">
          <Button onClick={() => window.print()}>Print poster</Button>
          <Button variant="secondary" onClick={() => void savePng()}>
            Save image
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
