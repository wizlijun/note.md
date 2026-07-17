// Minimal UI-only plugin entry: ask the host for vault info over the
// plugin:// fetch-RPC bridge and render the root path.
window.notemd
  .request("host.vault.info")
  .then((info) => {
    document.getElementById("app").textContent = info.root ?? "(no vault)";
  })
  .catch((err) => {
    document.getElementById("app").textContent = "error: " + err.message;
  });
