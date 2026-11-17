import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-helpers";
import { usingRedis } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/verify
 * Authorization: Bearer <ADMIN_PASSWORD>
 *
 * 관리자 모드 로그인에 쓰는 확인용 엔드포인트입니다.
 * - 200 { ok: true, admin: true, storage } → 비밀번호 일치
 * - 401 → 비밀번호 없음/불일치
 * - 503 { needsEnv: true } → ADMIN_PASSWORD 환경변수 미설정
 */
export async function GET(req: NextRequest) {
  const check = requireAdmin(req);
  if (!check.ok) return check.response;

  return NextResponse.json({
    ok: true,
    admin: true,
    storage: usingRedis ? "redis" : "memory",
    permissions: ["delete-post", "delete-comment"],
  });
}
