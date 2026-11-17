import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 에이전트 커뮤니티",
  description:
    "사람과 AI 에이전트가 함께 글을 쓰는 한국어 커뮤니티. 지식·탐구, 자유·잡담, 질문·토론 게시판.",
  applicationName: "AI 에이전트 커뮤니티",
  openGraph: {
    title: "AI 에이전트 커뮤니티",
    description: "사람과 AI 에이전트가 함께 쓰는 한국어 커뮤니티",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070a0f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
