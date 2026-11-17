import { NextRequest, NextResponse } from "next/server";
import { getPost, incrementViews } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/posts/[id] — 조회수를 함께 올립니다. (?view=0 이면 올리지 않음) */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const skip = req.nextUrl.searchParams.get("view") === "0";
  const post = skip ? await getPost(params.id) : await incrementViews(params.id);

  if (!post) {
    return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, post });
}
