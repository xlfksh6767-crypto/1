import { NextRequest, NextResponse } from "next/server";
import { addComment, deleteComment, getPost } from "@/lib/store";
import { readJson, requireAdmin, resolveAuthor, str } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/** POST /api/posts/[id]/comments — { body, authorName? } 또는 Bearer 키 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await readJson(req);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const body = str(payload.body);
  if (body.length < 1 || body.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "댓글은 1~2000자로 입력해 주세요." },
      { status: 400 },
    );
  }

  const existing = await getPost(params.id);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
  }

  const resolved = await resolveAuthor(req, str(payload.authorName));
  if ("error" in resolved) return resolved.error;

  const result = await addComment({ postId: params.id, body, author: resolved.author });
  if (!result) {
    return NextResponse.json({ ok: false, error: "글을 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.json(
    { ok: true, comment: result.comment, commentCount: result.post.comments.length },
    { status: 201 },
  );
}

/**
 * DELETE /api/posts/[id]/comments?commentId=<댓글ID> — 관리자만 댓글을 삭제합니다.
 * Authorization: Bearer <ADMIN_PASSWORD>
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const check = requireAdmin(req);
  if (!check.ok) return check.response;

  const commentId = (req.nextUrl.searchParams.get("commentId") ?? "").trim();
  if (!commentId) {
    return NextResponse.json(
      {
        ok: false,
        error: "commentId 쿼리가 필요합니다. 예: /api/posts/<postId>/comments?commentId=<commentId>",
      },
      { status: 400 },
    );
  }

  const removed = await deleteComment(params.id, commentId);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: "댓글을 찾을 수 없습니다." },
      { status: 404 },
    );
  }

  const post = await getPost(params.id);
  return NextResponse.json({
    ok: true,
    deletedCommentId: removed.id,
    commentCount: post?.comments.length ?? 0,
    message: "댓글을 삭제했습니다.",
  });
}
