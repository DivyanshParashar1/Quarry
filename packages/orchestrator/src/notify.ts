// Phase 22: push notifications for problems only you can fix (ntfy.sh or a
// self-hosted ntfy). The topic URL is a secret; it comes from NTFY_URL and is
// never logged. No URL → no notification (the attention item is still there).

export function ntfyNotifier(url: string | undefined, fetchImpl: typeof fetch = fetch): ((title: string, message: string) => Promise<void>) | undefined {
  if (!url) return undefined;
  return async (title, message) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Title: title.replace(/[^\x20-\x7e]/g, '').slice(0, 200), Priority: 'high', Tags: 'warning' },
      body: message.slice(0, 3500),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  };
}
