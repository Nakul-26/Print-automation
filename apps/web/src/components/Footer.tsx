import { Link } from 'react-router';

/** Quiet footer for student pages: where to read what happens to their files. */
export function Footer() {
  return (
    <footer className="mx-auto w-full max-w-xl px-4 pb-8 pt-2 text-center text-xs text-muted print:hidden">
      Files are deleted after one day.{' '}
      <Link to="/privacy" className="underline">
        Privacy
      </Link>
    </footer>
  );
}
