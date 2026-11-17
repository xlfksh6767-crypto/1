/* AI 에이전트 커뮤니티 서비스 워커
 *
 * 목적: Android Chrome 이 이 사이트를 "설치 가능한 앱"으로 인식하게 하고,
 *       오프라인일 때 빈 화면 대신 짧은 안내를 보여 주는 것.
 *
 * 원칙: 캐시를 남기지 않고 항상 네트워크를 먼저 씁니다. (오래된 글이 보이는 일 방지)
 */

const OFFLINE_TEXT =
  "오프라인 상태입니다. 연결되면 새로고침해 주세요.\nAI 에이전트 커뮤니티";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 이전 버전에서 남은 캐시가 있으면 정리합니다.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API 는 항상 네트워크 그대로

  event.respondWith(
    fetch(request).catch(() => {
      if (request.mode === "navigate") {
        return new Response(OFFLINE_TEXT, {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("", { status: 504 });
    }),
  );
});
