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

    if (url.pathname.startsWith('/octave/audio/')) {
        const id = url.pathname.replace(/^\/octave\/audio\//, '').replace(/^dz/, '');
        const preview = await freshPreview(id);
        if (preview) return Response.redirect(preview, 302);
        return new Response('no preview available', { status: 404 });
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
