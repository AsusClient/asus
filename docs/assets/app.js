/* =========================================================================
   asus.wtf — site behaviour
   ========================================================================= */

(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------ nav ------------------------------ */

  const nav = $("#nav");
  const navLinks = $("#navLinks");
  const navToggle = $("#navToggle");

  const onScroll = () => {
    nav.classList.toggle("is-scrolled", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (navToggle) {
    navToggle.addEventListener("click", () => {
      const open = navLinks.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    $$("a", navLinks).forEach((a) =>
      a.addEventListener("click", () => {
        navLinks.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  /* --------------------------- active link ------------------------- */

  const sections = $$("main section[id]");
  const linkFor = new Map(
    $$("a", navLinks)
      .map((a) => [a.getAttribute("href")?.replace("#", ""), a])
      .filter(([id]) => id)
  );

  if ("IntersectionObserver" in window && sections.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const link = linkFor.get(entry.target.id);
          if (!link) return;
          if (entry.isIntersecting) {
            linkFor.forEach((l) => l.classList.remove("is-active"));
            link.classList.add("is-active");
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((s) => spy.observe(s));
  }

  /* ----------------------------- reveal ---------------------------- */

  const revealables = $$(".reveal");

  if (!reduceMotion && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, i) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const delay = Math.min(i * 70, 280);
          setTimeout(() => el.classList.add("is-in"), delay);
          io.unobserve(el);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("is-in"));
  }

  /* ---------------------------- counters --------------------------- */

  const counters = $$("[data-count]");

  const runCounter = (el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    if (reduceMotion) {
      el.textContent = String(target);
      return;
    }
    const dur = 1100;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  if (counters.length && "IntersectionObserver" in window) {
    const co = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          runCounter(entry.target);
          co.unobserve(entry.target);
        });
      },
      { threshold: 0.6 }
    );
    counters.forEach((el) => co.observe(el));
  } else {
    counters.forEach((el) => (el.textContent = el.dataset.count));
  }

  /* -------------------------- card spotlight ----------------------- */

  if (!reduceMotion) {
    $$(".card").forEach((card) => {
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - r.left}px`);
        card.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }

  /* ---------------------------- parallax --------------------------- */

  const parallaxEls = $$("[data-parallax]");

  if (parallaxEls.length && !reduceMotion) {
    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;

    window.addEventListener(
      "pointermove",
      (e) => {
        tx = (e.clientX / window.innerWidth - 0.5) * 2;
        ty = (e.clientY / window.innerHeight - 0.5) * 2;
        if (!raf) raf = requestAnimationFrame(tick);
      },
      { passive: true }
    );

    function tick() {
      cx += (tx - cx) * 0.07;
      cy += (ty - cy) * 0.07;
      const depth = Number(parallaxEls[0].dataset.parallax) || 0.04;
      parallaxEls.forEach((el) => {
        el.style.transform = `translate3d(${(-cx * depth * 100).toFixed(2)}px, ${(
          -cy * depth * 100
        ).toFixed(2)}px, 0)`;
      });
      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    }
  }

  /* ---------------------------- lightbox --------------------------- */

  const lightbox = $("#lightbox");
  const lbImg = $("#lbImg");
  const lbClose = $("#lbClose");
  let lastFocus = null;

  const openLightbox = (src, alt) => {
    if (!lightbox) return;
    lastFocus = document.activeElement;
    lbImg.src = src;
    lbImg.alt = alt || "Screenshot";
    lightbox.hidden = false;
    document.body.style.overflow = "hidden";
    lbClose?.focus();
  };

  const closeLightbox = () => {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.style.overflow = "";
    lbImg.src = "";
    lastFocus?.focus?.();
  };

  $$(".shot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const img = $("img", btn);
      openLightbox(btn.dataset.full || img.src, img.alt);
    });
  });

  lbClose?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  /* --------------------------- copy version ------------------------ */

  const copyBtn = $("#copyVersion");

  copyBtn?.addEventListener("click", async () => {
    const text = copyBtn.dataset.copy || "1.21.11";
    const original = copyBtn.lastChild?.textContent?.trim() || "Copy MC version";
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.lastChild.textContent = " Copied!";
      setTimeout(() => {
        if (copyBtn.lastChild) copyBtn.lastChild.textContent = ` ${original}`;
      }, 1600);
    } catch {
      window.prompt("Minecraft version", text);
    }
  });

  /* ------------------------------ year ----------------------------- */

  const year = $("#year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ------------------------ smooth anchor fix ---------------------- */

  $$('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      const y = target.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top: y, behavior: reduceMotion ? "auto" : "smooth" });
      history.replaceState(null, "", `#${id}`);
    });
  });
})();
