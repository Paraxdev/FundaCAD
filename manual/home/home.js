(() => {
  const KEY = "/.__palette";

  function palette() {
    const form = document.querySelector("form[data-md-component=palette]");
    if (!form) return;
    const inputs = [...form.querySelectorAll("input")];
    const show = (index) => {
      inputs.forEach((input, i) => {
        input.checked = i === index;
        input.nextElementSibling.hidden = i !== index;
      });
    };
    const apply = (index, store) => {
      const input = inputs[index];
      const media = input.dataset.mdColorMedia;
      let scheme = input.dataset.mdColorScheme;
      if (media === "(prefers-color-scheme)") {
        scheme = matchMedia("(prefers-color-scheme: light)").matches ? "default" : "slate";
      }
      document.body.setAttribute("data-md-color-scheme", scheme);
      show(index);
      if (store) {
        const color = { media, scheme: input.dataset.mdColorScheme, primary: "indigo", accent: "indigo" };
        try {
          localStorage.setItem(KEY, JSON.stringify({ index, color }));
        } catch (e) {}
      }
    };
    const start = Number(document.body.dataset.fcPalette) || 0;
    apply(start < inputs.length ? start : 0, false);
    inputs.forEach((input, i) => input.addEventListener("change", () => apply(i, true)));
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      const i = inputs.findIndex((input) => input.checked);
      if (inputs[i].dataset.mdColorMedia === "(prefers-color-scheme)") apply(i, false);
    });
  }

  // Each kind of file the release carries, in the order listed. The first match for the visitor's system is offered
  // on the big button. Signatures, updater bundles and plugins are not for download by hand.
  const KINDS = [
    { os: "windows", test: /windows.*setup\.exe$/i, label: "Installer (.exe)" },
    { os: "windows", test: /windows.*\.msi$/i, label: "MSI package" },
    { os: "windows", test: /windows.*portable\.exe$/i, label: "Portable, no install (.exe)" },
    { os: "macos", test: /macos.*\.dmg$/i, label: "Disk image for Apple silicon (.dmg)" },
    { os: "linux", test: /\.AppImage$/i, label: "AppImage" },
    { os: "linux", test: /\.flatpak$/i, label: "Flatpak" },
    { os: "linux", test: /\.deb$/i, label: "Debian and Ubuntu (.deb)" },
    { os: "linux", test: /\.rpm$/i, label: "Fedora and openSUSE (.rpm)" },
  ];
  const OS_NAMES = { windows: "Windows", macos: "macOS", linux: "Linux" };

  function visitorOs() {
    const ua = navigator.userAgent;
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/android|iphone|ipad|ipod/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile)) return null;
    if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) return navigator.maxTouchPoints > 1 ? null : "macos";
    if (/linux/i.test(platform) || /linux/i.test(ua)) return "linux";
    return null;
  }

  const megabytes = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function render(box, release, releasesUrl) {
    const files = [];
    for (const asset of release.assets || []) {
      const kind = KINDS.find((k) => k.test.test(asset.name));
      if (kind) files.push({ ...kind, rank: KINDS.indexOf(kind), name: asset.name, url: asset.browser_download_url, size: asset.size });
    }
    files.sort((a, b) => a.rank - b.rank);
    const when = new Date(release.published_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const head = `<h2>${esc(release.name || release.tag_name)}</h2>
      <p class="fc-release-meta">Released ${esc(when)}. <a href="${esc(release.html_url)}">Release notes</a></p>`;
    if (!files.length) {
      box.innerHTML = `${head}<p>This release has no installers attached. Look on the <a href="${esc(releasesUrl)}">releases page</a>.</p>`;
      return;
    }
    const os = visitorOs();
    const main = files.find((f) => f.os === os);
    const pick = main
      ? `<a class="fc-btn fc-btn-primary fc-btn-big" href="${esc(main.url)}">Download for ${OS_NAMES[main.os]}</a>
         <p class="fc-file">${esc(main.name)}, ${megabytes(main.size)}</p>`
      : `<p>FundaCAD runs on Windows, macOS and Linux computers. Pick the file for yours.</p>`;
    const groups = Object.keys(OS_NAMES)
      .map((key) => {
        const rows = files.filter((f) => f.os === key && f !== main);
        if (!rows.length) return "";
        const items = rows.map((f) => `<li><a href="${esc(f.url)}">${esc(f.label)}</a><span>${megabytes(f.size)}</span></li>`).join("");
        return `<h3>${OS_NAMES[key]}</h3><ul>${items}</ul>`;
      })
      .join("");
    box.innerHTML = `${head}${pick}<div class="fc-others"><h2 class="fc-visually-hidden">Other downloads</h2>${groups}</div>`;
  }

  function download() {
    const page = document.querySelector(".fc-download");
    if (!page) return;
    const box = page.querySelector(".fc-release");
    const repo = page.dataset.fcRepo;
    const releasesUrl = `https://github.com/${repo}/releases`;
    const status = box.querySelector(".fc-release-status");
    status.textContent = "Looking up the latest beta on GitHub.";
    fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
      .then((response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then((release) => {
        if (release) render(box, release, releasesUrl);
        else box.innerHTML = `<p>There is no FundaCAD release yet. When there is, it will be on the <a href="${esc(releasesUrl)}">releases page</a>.</p>`;
      })
      .catch(() => {
        box.innerHTML = `<p>GitHub did not answer, so the files cannot be listed here. They are all on the <a href="${esc(releasesUrl)}">releases page</a>.</p>`;
      });
  }

  palette();
  download();
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("fc-ready")));
})();
