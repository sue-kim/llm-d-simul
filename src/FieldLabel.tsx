import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export function FieldLabel({ label, htmlFor, help }: { label: string; htmlFor: string; help?: string }) {
  return <span className="field-label"><label htmlFor={htmlFor}>{label}</label>{help && <FieldHelp label={label} text={help} />}</span>;
}

function FieldHelp({ label, text }: { label: string; text: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !popover.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const content = popover.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left - 8, window.innerWidth - content.width - 12));
    const below = anchor.bottom + 8;
    const top = below + content.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - content.height - 8);
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => { if (popover.current?.matches(':popover-open')) popover.current.hidePopover(); };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  return <>
    <button type="button" className="field-help-button" ref={trigger} popoverTarget={id} aria-label={`About ${label}`} aria-expanded={open} aria-describedby={open ? id : undefined}>
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M7.9 7.5a2.1 2.1 0 0 1 4.2 0c0 1.5-2.1 1.7-2.1 3.2" /><path d="M10 13.5h.01" /></svg>
    </button>
    <span ref={popover} id={id} popover="auto" role="tooltip" className="field-help-popover" style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onToggle={event => { setOpen(event.newState === 'open'); if (event.newState === 'closed') setPosition(null); }}>
      <strong>{label}</strong><span>{text}</span>
    </span>
  </>;
}
