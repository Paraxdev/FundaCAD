(() => {
  const mem = new Map();
  // Safe mode speaks the saved language, and only that: a plain code or system, never a drop-in key.
  try {
    const lang = window.localStorage.getItem("fundacad.language");
    if (lang !== null && /^(system|[a-z]{2,3}(-([A-Z]{2}|[0-9]{3}))?)$/.test(lang)) mem.set("fundacad.language", lang);
  } catch {}
  const storage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); },
    removeItem: (k) => { mem.delete(String(k)); },
    clear: () => mem.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
})();
