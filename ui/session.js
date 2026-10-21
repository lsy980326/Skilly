const connectionKey = "skilly.viewer.connection.v1";
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const validToken = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

// Storage belongs to the full browser origin, including the local port.
// Remembering a credential never replaces server authorization on each request.
export function createViewerSession({ location, history, getStorage, now = Date.now }) {
  const linkToken = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  let limited = false, attemptedSave = false;
  const decode = raw => {
    if (raw === null || raw.length > 1024) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const stored = () => decode(getStorage().getItem(connectionKey));
  let initialStored;
  try { initialStored = getStorage().getItem(connectionKey); } catch { limited = true; }
  let token = linkToken, expiresAt = now() + retentionMs;
  if (linkToken === null) {
    try {
      const entry = decode(initialStored);
      if (entry?.version === 1 && validToken(entry.token) && Number.isSafeInteger(entry.expiresAt)
        && entry.expiresAt > now() && entry.expiresAt <= now() + retentionMs) {
        token = entry.token; expiresAt = entry.expiresAt;
      } else if (getStorage().getItem(connectionKey) !== null) getStorage().removeItem(connectionKey);
    } catch { limited = true; }
  }
  if (linkToken === null && validToken(token)) attemptedSave = true;
  function reject() {
    const rejectedToken = token;
    token = null;
    try {
      // Another tab may have saved a newer connection while this request ran.
      if (stored()?.token === rejectedToken) getStorage().removeItem(connectionKey);
    } catch { limited = true; }
  }
  return {
    headers() {
      if (!validToken(token) || expiresAt <= now()) {
        if (token !== null && expiresAt <= now()) reject();
        throw new Error("연결 주소가 필요합니다. Skilly를 실행한 터미널의 전체 주소로 다시 열어 주세요.");
      }
      return { Authorization: `Bearer ${token}` };
    },
    confirm() {
      if (attemptedSave || !validToken(token)) return;
      attemptedSave = true;
      try {
        const storage = getStorage();
        // A delayed response from an earlier server must not replace a newer
        // tab's connection. Restored credentials need no redundant writes.
        const current = storage.getItem(connectionKey);
        if (current !== null && current !== initialStored) return;
        storage.setItem(connectionKey, JSON.stringify({ version: 1, token, expiresAt }));
        limited = false;
      } catch { limited = true; }
    },
    reject,
    get persistenceLimited() { return limited; },
  };
}
