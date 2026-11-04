/* Registers the COI service worker; include on every page that needs SharedArrayBuffer. */
(function () {
  if (window.crossOriginIsolated) return;
  if (!window.isSecureContext) { console.warn("COI: not a secure context"); return; }
  if (!navigator.serviceWorker) { console.warn("COI: no serviceWorker support"); return; }

  const reloaded = sessionStorage.getItem("coiReloadedBySelf");
  sessionStorage.removeItem("coiReloadedBySelf");

  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(
    (reg) => {
      if (reg.controller) {
        if (!reloaded) {
          sessionStorage.setItem("coiReloadedBySelf", "1");
          location.reload();
        }
      } else {
        reg.addEventListener("controllerchange", () => {
          if (!reloaded) {
            sessionStorage.setItem("coiReloadedBySelf", "1");
            location.reload();
          }
        });
      }
    },
    (err) => console.error("COI SW registration failed:", err)
  );
})();
