import { useEffect, useState } from "react";

export type Density = "compact" | "standard" | "roomy";
const KEY = "proximity:density";
const EVENT = "proximity:density-change";

function read(): Density {
  if (typeof window === "undefined") return "standard";
  const v = localStorage.getItem(KEY);
  return v === "compact" || v === "roomy" ? v : "standard";
}

function apply(d: Density) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", d);
}

// Apply once at module load so first paint matches user pref.
if (typeof window !== "undefined") apply(read());

export function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>(read);

  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<Density>).detail;
      if (next) setDensity(next);
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  const setAndPersist = (d: Density) => {
    localStorage.setItem(KEY, d);
    apply(d);
    window.dispatchEvent(new CustomEvent<Density>(EVENT, { detail: d }));
    setDensity(d);
  };

  return [density, setAndPersist];
}