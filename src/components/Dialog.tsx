import { useEffect } from "preact/hooks";

export function Dialog({ title, onClose, children }: { title: string; onClose(): void; children: preact.ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div class="dialog">
        <div class="spread"><h2>{title}</h2><button class="quiet" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
