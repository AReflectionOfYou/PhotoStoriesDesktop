// A thumbnail that loads when it scrolls into view, a few at a time.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "preact/hooks";

let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await job();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** `source`: a photo anywhere (thumbnail made in Rust); `file`: a ready JPEG such as thumb.jpg. */
export function Thumb({ source, file, alt = "" }: { source?: string; file?: string; alt?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      try {
        const bytes = await limited(() => (file ? invoke<ArrayBuffer>("read_file", { path: file }) : invoke<ArrayBuffer>("thumbnail", { path: source, max: 320 })));
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setUrl(made);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }, { rootMargin: "200px" });
    if (ref.current) io.observe(ref.current);
    return () => {
      cancelled = true;
      io.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [source, file]);
  return <div ref={ref}>{url ? <img src={url} alt={alt} /> : <div class="ph" title={failed ? "This photo can't be shown" : ""} />}</div>;
}
