/* =========================================================================
   asus.wtf — small DOM helpers shared by the account pages
   ========================================================================= */

/** Fills the "accounts aren't connected" card. Only called when unconfigured. */
export function mountConfigNotice(element) {
  if (!element) return;
  element.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = "Accounts aren't connected yet.";

  const body = document.createElement("p");
  body.append("Add the Firebase web keys to ");
  const file = document.createElement("code");
  file.textContent = "assets/firebase-config.js";
  body.append(file, " — every step is in ");
  const link = document.createElement("a");
  link.className = "link";
  link.href = "AUTH-SETUP.md";
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "the setup guide";
  body.append(link, ".");

  element.append(title, body);
  element.hidden = false;
}

/** Wire every [data-eye] button to the input it names. */
export function setupEyes() {
  document.querySelectorAll("[data-eye]").forEach((button) => {
    const input = document.getElementById(button.dataset.eye || "");
    if (!input) return;
    button.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      button.textContent = showing ? "Show" : "Hide";
      button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  });
}

/** Turn a form off until the owner connects a real project. */
export function lockForms() {
  document.querySelectorAll("form input, form button, .btn-google").forEach((element) => {
    element.disabled = true;
  });
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.idleLabel;
  button.classList.toggle("is-busy", busy);
}

export function setMessage(element, text, ok) {
  if (!element) return;
  element.textContent = text || "";
  element.classList.toggle("is-ok", Boolean(ok));
}
