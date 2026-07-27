import { NextResponse } from "next/server";
import { isSecureSessionCookie, SESSION_COOKIE } from "@/lib/auth";
import { isSameOrigin } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ message: "Origem não permitida." }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: isSecureSessionCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  return response;
}
