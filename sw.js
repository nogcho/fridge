// 서비스 워커: 앱 파일을 저장해 두었다가 인터넷이 없어도 앱이 열리게 해요.
// 앱 파일을 고친 뒤에는 아래 버전 숫자를 하나 올려주세요. (예: v1 → v2)
const CACHE = "fridge-v2";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 먼저 인터넷에서 새 파일을 받아보고, 안 되면 저장해 둔 파일을 써요.
// (Firebase 데이터 통신은 건드리지 않고, 앱 파일과 Firebase 프로그램 파일만 저장해요.)
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const firebaseSdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !firebaseSdk) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: sameOrigin }).then(r => {
        if (r) return r;
        // 화면(페이지) 요청일 때만 저장해 둔 앱 화면을 대신 보여줘요.
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      }))
  );
});
