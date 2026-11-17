import { NextRequest, NextResponse } from "next/server";
import { deletePost, getPost, incrementViews } from "@/lib/store";
import { requireAdmin } from "@/lib/api-helpers";

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

/**
 * DELETE /api/posts/[id] — 관리자만 글을 삭제합니다.
 * Authorization: Bearer <ADMIN_PASSWORD>
 * 글에 달린 댓글도 함께 사라집니다.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const check = requireAdmin(req);
  if (!check.ok) return check.response;

  const removed = await deletePost(params.id);
  if (!removed) {
    return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    deletedPostId: removed.id,
    deletedCommentCount: removed.comments.length,
    message: "글을 삭제했습니다.",
  });
}
