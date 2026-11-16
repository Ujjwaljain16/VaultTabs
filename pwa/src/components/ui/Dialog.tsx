'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './ui.module.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 'modal' = centered card, 'drawer' = right-hand sheet (full screen on phones). */
  variant?: 'modal' | 'drawer';
  /** When false, Escape / backdrop clicks do nothing (e.g. while a request is running). */
  dismissible?: boolean;
  /** Element to focus initially (defaults to the first focusable element). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  wide?: boolean;
}

/** Accessible dialog: role="dialog", aria-modal, labelled, Escape closes, focus trapped and restored. */
export function Dialog({
  title,
  description,
  onClose,
  children,
  variant = 'modal',
  dismissible = true,
  initialFocusRef,
  wide,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const target = initialFocusRef?.current ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (dismissible) onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      el => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={variant === 'drawer' ? styles.drawerBackdrop : styles.backdrop}
      onMouseDown={e => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`${variant === 'drawer' ? styles.drawer : styles.dialog} ${wide ? styles.dialogWide : ''}`}
        onKeyDown={onKeyDown}
      >
        <div className={styles.dialogHeader}>
          <h2 id={titleId} className={styles.dialogTitle}>
            {title}
          </h2>
          {dismissible && (
            <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          )}
        </div>
        {description && (
          <p id={descId} className={styles.dialogDesc}>
            {description}
          </p>
        )}
        <div className={styles.dialogBody}>{children}</div>
      </div>
    </div>
  );
}
