const AUTH_KEY = "deskBasicAuth_v1";

export function getDeskAuthHeader(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(AUTH_KEY);
}

export function setDeskAuth(user: string, password: string) {
  const token = btoa(`${user}:${password}`);
  window.sessionStorage.setItem(AUTH_KEY, `Basic ${token}`);
}

export function clearDeskAuth() {
  window.sessionStorage.removeItem(AUTH_KEY);
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
