import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

/**
 * Keeps one socket open while the page is mounted and calls `onChange` whenever the server says
 * something changed, and again after every (re)connect so nothing missed while offline stays missing.
 * Events carry no data: the caller refetches over HTTP. Returns whether the socket is connected.
 */
export function useRealtime(opts: {
  /** Event that joins the right rooms, with its payload. Pass null to stay disconnected. */
  watch: { event: string; payload: object } | null;
  /** Events that mean "refetch". */
  changeEvents: string[];
  onChange: () => void;
}): boolean {
  const [connected, setConnected] = useState(false);
  const onChange = useRef(opts.onChange);
  onChange.current = opts.onChange;

  const watchKey = opts.watch ? JSON.stringify(opts.watch) : null;
  const eventsKey = opts.changeEvents.join(',');

  useEffect(() => {
    if (!watchKey) return;
    const watch = JSON.parse(watchKey) as { event: string; payload: object };
    const socket = io({ withCredentials: true });

    const join = () => {
      socket.emit(watch.event, watch.payload, (reply: { ok?: boolean } | undefined) => {
        // Joined: fetch once so anything that happened while we were away shows up.
        if (reply?.ok) {
          setConnected(true);
          onChange.current();
        }
      });
    };
    socket.on('connect', join);
    socket.on('disconnect', () => setConnected(false));
    for (const event of eventsKey.split(',')) socket.on(event, () => onChange.current());

    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [watchKey, eventsKey]);

  return connected;
}
