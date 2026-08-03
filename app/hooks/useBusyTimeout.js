import { useEffect, useState } from "react";

// Safety net for fetcher-driven busy/disabled button state. If a fetcher's
// request never settles back to "idle" (dropped network, an action throwing
// a non-Response error, etc.), the button it disables would otherwise stay
// stuck forever. After `timeoutMs` of continuous busy-ness this flips back
// to false so the button re-enables and the user can retry.
export function useBusyTimeout(busy, timeoutMs = 10000) {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const timer = setTimeout(() => setStuck(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [busy, timeoutMs]);

  return busy && !stuck;
}
