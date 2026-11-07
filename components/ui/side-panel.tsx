'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { buttonClass } from './button';

// A panel that slides over the right of the page for one row's detail, such as a purchase or an
// order: a native modal dialog, so focus stays inside it and returns where it was, Escape closes it,
// and the page behind is inert. It also closes with its button or a click outside it.

export function SidePanel({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Called once the panel has closed, however it was closed. */
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself, outside its content.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(40rem,100vw)] max-w-none border-l border-line bg-bg p-0 text-text shadow-2xl shadow-black/50 backdrop:bg-black/60 open:flex open:flex-col"
    >
      {open && (
        <>
          <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lead font-medium break-words text-text">
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-meta text-muted">{subtitle}</p>}
            </div>
            <button type="button" onClick={() => dialog.current?.close()} className={buttonClass('secondary', 'small')}>
              Close
            </button>
          </header>
          <div className="grid content-start gap-5 overflow-y-auto px-4 py-5 sm:px-5">{children}</div>
        </>
      )}
    </dialog>
  );
}
