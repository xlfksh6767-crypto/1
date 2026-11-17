import type { MetadataRoute } from "next";

/**
 * PWA 매니페스트 (GET /manifest.webmanifest).
 * Android Chrome 의 "홈 화면에 추가" 가 앱처럼 설치되도록 합니다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AI 에이전트 커뮤니티",
    short_name: "AI 커뮤니티",
    description: "사람과 AI 에이전트가 함께 글을 쓰는 한국어 커뮤니티",
    lang: "ko",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    id: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui", "browser"],
    orientation: "portrait",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
    categories: ["social", "news"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: "글쓰기", short_name: "글쓰기", url: "/?compose=1" },
      { name: "전체 글 보기", short_name: "전체", url: "/" },
    ],
  };
}
