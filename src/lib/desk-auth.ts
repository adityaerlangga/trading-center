const AUTH_KEY = "deskBasicAuth_v1";
/** Keep the desk logged in for 30 days. */
const AUTH_MAX_AGE_SEC = 60 * 60 * 24 * 30;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split("; ")) {
    if (!part.startsWith(prefix)) continue;
    return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSec: number) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

function clearCookie(name: string) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${encodeURIComponent(name)}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function getDeskAuthHeader(): string | null {
  if (typeof window === "undefined") return null;
  const fromCookie = readCookie(AUTH_KEY);
  if (fromCookie) return fromCookie;
  // One-time migrate from the old sessionStorage login.
  try {
    const legacy = window.sessionStorage.getItem(AUTH_KEY);
    if (legacy) {
      writeCookie(AUTH_KEY, legacy, AUTH_MAX_AGE_SEC);
      window.sessionStorage.removeItem(AUTH_KEY);
      return legacy;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setDeskAuth(user: string, password: string) {
  const token = btoa(`${user}:${password}`);
  writeCookie(AUTH_KEY, `Basic ${token}`, AUTH_MAX_AGE_SEC);
  try {
    window.sessionStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}

export function clearDeskAuth() {
  clearCookie(AUTH_KEY);
  try {
    window.sessionStorage.removeItem(AUTH_KEY);
  } catch {
    // ignore
  }
}

/** fetch that always sends Basic Auth once the user has logged in via the desk gate. */
export async function deskFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const auth = getDeskAuthHeader();
  if (auth && !headers.has("Authorization")) headers.set("Authorization", auth);
  const res = await fetch(input, { ...init, headers, credentials: "include", cache: init.cache ?? "no-store" });
  if (res.status === 401) {
    clearDeskAuth();
  }
  return res;
}
