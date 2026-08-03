import { useEffect, useRef, useState } from "react";
import { useFetchers, useNavigation } from "react-router";

// Global top-of-page progress bar. Reacts to BOTH full-page navigations
// (useNavigation) and background fetcher actions (useFetchers — Edit Fields,
// Delete, Save, Contact form, etc.), so every click gives the user immediate
// visual feedback that something is happening, instead of the app appearing
// to freeze while a request is in flight.
export default function TopLoadingBar() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const isActive =
    navigation.state !== "idle" || fetchers.some((f) => f.state !== "idle");

  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);
  const timersRef = useRef([]);

  useEffect(() => {
    const clearTimers = () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };

    if (isActive) {
      clearTimers();
      setFading(false);
      setVisible(true);
      // Jump quickly, then creep toward 85% while the request is in flight —
      // never reaches 100% until we know the work actually finished.
      setProgress(15);
      timersRef.current.push(setTimeout(() => setProgress(45), 120));
      timersRef.current.push(setTimeout(() => setProgress(70), 400));
      timersRef.current.push(setTimeout(() => setProgress(85), 1000));
    } else if (visible) {
      setProgress(100);
      timersRef.current.push(setTimeout(() => setFading(true), 200));
      timersRef.current.push(
        setTimeout(() => {
          setVisible(false);
          setProgress(0);
          setFading(false);
        }, 500)
      );
    }

    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        zIndex: 9999,
        pointerEvents: "none",
        opacity: fading ? 0 : 1,
        transition: "opacity 0.3s ease",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "linear-gradient(90deg, #1d4ed8, #60a5fa)",
          boxShadow: "0 0 8px rgba(37,99,235,0.6)",
          transition: progress === 100 ? "width 0.2s ease" : "width 0.4s ease",
        }}
      />
    </div>
  );
}
