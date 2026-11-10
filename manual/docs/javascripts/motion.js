// An animation is written into a page as its still, marked { .fc-motion }. Where the system allows motion the GIF
// plays, under reduced motion the still stays, and a button below either plays or pauses it.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function show(img, playing) {
    img.src = playing ? img.dataset.fcGif : img.dataset.fcStill;
    img.dataset.fcPlaying = String(playing);
    img.nextElementSibling.textContent = playing ? "Pause animation" : "Play animation";
  }

  function setUp(img) {
    if (img.dataset.fcStill) return;
    img.dataset.fcStill = img.src;
    img.dataset.fcGif = img.src.replace(/-still\.png$/, ".gif");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fc-motion-toggle";
    button.addEventListener("click", () => {
      img.dataset.fcChosen = "true";
      show(img, img.dataset.fcPlaying !== "true");
    });
    img.after(button);
    show(img, !reduce.matches);
  }

  const images = () => document.querySelectorAll(".md-typeset img.fc-motion");
  // A choice made with the button outlasts a later change of the system setting.
  reduce.addEventListener("change", () => {
    for (const img of images()) if (!img.dataset.fcChosen) show(img, !reduce.matches);
  });

  const run = () => images().forEach(setUp);
  if (window.document$ && typeof window.document$.subscribe === "function") window.document$.subscribe(run);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
