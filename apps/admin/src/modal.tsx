import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab") return;
      const items = ref.current?.querySelectorAll<HTMLElement>(
        "input:not(:disabled),button:not(:disabled),select:not(:disabled)",
      );
      if (!items?.length) return;
      if (e.shiftKey && document.activeElement === items[0]) {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
      if (!e.shiftKey && document.activeElement === items[items.length - 1]) {
        e.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
