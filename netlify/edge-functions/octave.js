// Netlify Edge Function: proxies /octave/* to the Octave API.
//
// Two problems this solves:
//  1. The API sits behind Cloudflare and refuses connections from most
//     server IPs (Netlify Functions/Lambda included) — the edge network
//     uses different egress IPs.
//  2. The API returns "Forbidden" to browser User-Agents, so we rewrite
//     the UA to a neutral one before proxying.
//
// Special route: /octave/audio/{dz-id} resolves a FRESH 30-second preview
// URL at play time (preview signatures expire) and 302-redirects to it.
// The player calls same-origin /octave/… so there are no CORS issues.
const API = 'https://api.octavestreaming.com';
const HEADERS = { 'user-agent': 'Waxline/1.0' };

/** Get a playback token for full-track audio using the user's Octave account key. */
async function playbackToken(accountKey) {
    try {
        const r = await fetch(`${API}/api/playback-token`, {
            headers: { ...HEADERS, Authorization: `Bearer ${accountKey}` },
        });
        if (!r.ok) return null;
        const d = await r.json();
        return d.token || null;
    } catch (e) {
        return null;
    }
}
/** Preview signatures expire; return a preview valid for 2+ minutes. */
async function freshPreview(id) {
    const usable = (pv) => {
        if (typeof pv !== 'string' || !pv) return false;
        const m = pv.match(/exp=(\d+)/);
        return !m || parseInt(m[1], 10) > Date.now() / 1000 + 120;
    };
    try {
        const t = await (
            await fetch(`${API}/dz/track/${encodeURIComponent(id)}`, { headers: HEADERS })
        ).json();
        if (usable(t.preview)) return t.preview;
        // stale cache entry on the API: re-search by title+artist for a fresh signature
        const q = encodeURIComponent(`${t.title || ''} ${t.artist?.name || ''}`.trim());
        if (!q) return null;
        const s = await (
            await fetch(`${API}/dz/search/track?q=${q}&limit=10`, { headers: HEADERS })
        ).json();
        const items = s.data || [];
        const hit = items.find((x) => String(x.id) === String(id)) || items[0];
        if (hit && usable(hit.preview)) return hit.preview;
    } catch (e) {
        /* ignore */
    }
    return null;
}

export default async (request) => {
    const url = new URL(request.url);

    // Exchange the user's Octave account key for a short-lived playback
    // token (~1h). The account key arrives in a header (never in a URL or
    // the repo); only the short-lived token is ever placed in a URL.
    if (url.pathname === '/octave/token') {
        const key = request.headers.get('x-octave-key');
        if (!key) return new Response('missing key', { status: 401 });
        const token = await playbackToken(key);
        if (!token) return new Response('invalid key', { status: 403 });
        return Response.json(
            { token, expiresIn: 3600 },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    // Stream full-track audio. The URL carries the short-lived playback
    // token (not the account key). Range requests are forwarded for seeking.
    if (url.pathname.startsWith('/octave/stream/')) {
        const parts = url.pathname.replace(/^\/octave\/stream\//, '').split('/');
        const token = parts[0],
            quality = parts[1] || 'HIGH';
        const trackId = url.searchParams.get('track');
        if (!token || !trackId) return new Response('bad request', { status: 400 });
        const range = request.headers.get('range');
        const audio = await fetch(
            `${API}/audio/${encodeURIComponent(quality)}?track=${encodeURIComponent(trackId)}`,
            {
                headers: {
                    ...HEADERS,
                    Authorization: `Bearer ${token}`,
                    ...(range ? { Range: range } : {}),
                },
            }
        );
        if (!audio.ok) return new Response('audio unavailable', { status: audio.status });
        const headers = new Headers();
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
            const v = audio.headers.get(h);
            if (v) headers.set(h, v);
        });
        headers.set('Cache-Control', 'no-store');
        return new Response(audio.body, { status: audio.status, headers });
    }

    if (url.pathname.startsWith('/octave/audio/')) {
        const id = url.pathname.replace(/^\/octave\/audio\//, '').replace(/^dz/, '');
        const preview = await freshPreview(id);
        if (preview) return Response.redirect(preview, 302);
        return new Response('no preview available', { status: 404 });
    }

    // YouTube search for full-track playback (via public Piped API instances).
    // Returns the top video match: { id, title, duration }.
    if (url.pathname.startsWith('/octave/yt/')) {
        const q = url.searchParams.get('q') || '';
        if (!q) return new Response('missing q', { status: 400 });
        const instances = [
            'https://api.piped.private.coffee',
            'https://pipedapi.adminforge.de',
        ];
        for (const base of instances) {
            try {
                const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`, {
                    headers: HEADERS,
                });
                if (!r.ok) continue;
                const d = await r.json();
                const items = (d.items || []).filter(
                    (i) => i && typeof i.url === 'string' && i.url.startsWith('/watch?v=')
                );
                if (items.length) {
                    const v = items[0];
                    return Response.json(
                        {
                            id: v.url.slice(9),
                            title: v.title || '',
                            duration: Number(v.duration) || 0,
                        },
                        { headers: { 'Cache-Control': 'public, max-age=86400' } }
                    );
                }
            } catch (e) {
                /* try next instance */
            }
        }
        return new Response('no video found', { status: 404 });
    }

    const target = API + url.pathname.replace(/^\/octave/, '') + url.search;

    const headers = new Headers(request.headers);
    headers.set('user-agent', 'Waxline/1.0');
    headers.delete('referer');
    headers.delete('origin');

    const res = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
    // Cache API responses on Netlify's CDN: catalogue data is near-static,
    // so repeat visits (and repeat navigations) serve in milliseconds.
    // The /octave/audio/ route above is never cached (fresh preview each play).
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'public, max-age=120, s-maxage=1800');
    return out;
};

export const config = { path: '/octave/*' };
