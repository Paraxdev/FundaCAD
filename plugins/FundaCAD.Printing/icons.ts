// Compile-time constants only: these reach the DOM through the app's Icon component.
export const ICONS: Record<string, string> = {
  print:
    '<path d="M6 17V4h12v13"/><line x1="6" y1="8" x2="18" y2="8"/><path d="M10.5 8v2l1.5 2l1.5-2V8"/>' +
    '<rect x="3" y="17" width="18" height="3.5" rx="1"/>',
  slicer:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><path d="M11 14h5m0 0l-2-2m2 2l-2 2"/>',
  printerSend:
    '<path d="M4 17V4h10v13"/><line x1="4" y1="8" x2="14" y2="8"/><path d="M7.5 8v2l1.5 2l1.5-2V8"/>' +
    '<rect x="2" y="17" width="14" height="3.5" rx="1"/><path d="M17.5 12h3.5m0 0l-2-2m2 2l-2 2"/>',
};
