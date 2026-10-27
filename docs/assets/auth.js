/* =========================================================================
   asus.wtf — auth chip + gated download wiring
   Loads after app.js. Fails silent when the site is opened from disk.
   ========================================================================= */

(() => {
  "use strict";

  const navActions = document.querySelector(".nav-actions");
  if (!navActions) return;

  const state = { authEnabled: false, user: null };

  const chip = document.createElement("div");
  chip.className = "auth-chip";
  chip.hidden = true;

  const avatar = document.createElement("img");
  avatar.alt = "";
  avatar.width = 22;
  avatar.height = 22;
  avatar.loading = "lazy";

  const label = document.createElement("span");
  label.className = "auth-name";

  const act = document.createElement("button");
  act.className = "auth-action";
  act.type = "button";

  chip.append(avatar, label, act);

  const render = () => {
    if (!state.authEnabled) return;
    chip.hidden = false;

    if (state.user) {
      const name = state.user.globalName || state.user.username || "account";
      label.textContent = name;
      avatar.src = state.user.avatar
        ? `https://cdn.discordapp.com/avatars/${state.user.id}/${state.user.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${Number(state.user.id.slice(-1)) % 5}.png`;
      avatar.alt = `${name} avatar`;
      act.textContent = "Sign out";
      act.onclick = () => {
        window.location.href = "/auth/logout";
      };
    } else {
      label.textContent = "Guest";
      avatar.removeAttribute("src");
      avatar.style.visibility = "hidden";
      act.textContent = "Sign in";
      act.onclick = () => {
        window.location.href = `/auth/discord?next=${encodeURIComponent(location.pathname)}`;
      };
    }
  };

  // insert before the primary download button so it reads: [chip] [Fabric API] [Download]
  const firstBtn = navActions.querySelector(".btn-primary");
  navActions.insertBefore(chip, firstBtn || null);

  const rewriteDownloads = () => {
    if (!state.authEnabled) return;
    document.querySelectorAll("a[href$='.jar']").forEach((a) => {
      a.setAttribute("href", "/download");
      a.removeAttribute("download");
    });
  };

  const load = async () => {
    try {
      const cfg = await fetch("/api/config", { headers: { Accept: "application/json" } });
      if (!cfg.ok) return;
      const info = await cfg.json();
      state.authEnabled = Boolean(info.authEnabled);
      if (!state.authEnabled) return;

      const me = await fetch("/api/me", { headers: { Accept: "application/json" } });
      if (me.ok) {
        const data = await me.json();
        state.user = data.user || null;
      }
      render();
      rewriteDownloads();
    } catch {
      /* opened as a file, or the API is not mounted — leave the static site alone */
    }
  };

  load();
})();
