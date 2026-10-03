// A previously installed production worker can cache Vite's development modules.
// Release this app's worker before loading those modules during local development.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  const workerUrl = new URL("sw.js", document.baseURI).href;
  const controlledByApp = navigator.serviceWorker.controller?.scriptURL === workerUrl;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations
    .filter(registration => [registration.active, registration.waiting, registration.installing]
      .some(worker => worker?.scriptURL === workerUrl))
    .map(registration => registration.unregister()));
  if (controlledByApp) location.reload();
  else await import("./app.js");
} else {
  await import("./app.js");
}
