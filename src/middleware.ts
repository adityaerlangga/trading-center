import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function unauthorized() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Trading Center"',
      "Cache-Control": "no-store",
    },
  });
}

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") {
    return NextResponse.next();
  }

  const user = process.env.DESK_AUTH_USER?.trim();
  const password = process.env.DESK_AUTH_PASSWORD ?? "";
  if (!user) return NextResponse.next();

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep < 0) return unauthorized();
    const givenUser = decoded.slice(0, sep);
    const givenPassword = decoded.slice(sep + 1);
    if (givenUser !== user || givenPassword !== password) return unauthorized();
  } catch {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
