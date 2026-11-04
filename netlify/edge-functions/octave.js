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

// ---------------------------------------------------------------------------
// Gaana playback (added 2026-11-04).
//
// GaanaPy (github.com/ZingyTomato/GaanaPy) wraps Gaana's public apiv2, but
// it is broken as written: it POSTs with an EMPTY body, and Gaana's Akamai
// front door rejects empty POSTs with "Bad Request". Sending the same POST
// with a non-empty body returns real track data — that one-line fix is what
// makes this route work at all. No account, token or login is needed.
//
// Flow: search apiv2 -> songDetail for the best matches -> decrypt the
// obfuscated stream URL (AES-128-CBC, hardcoded key from GaanaPy, which
// Gaana may rotate) -> return a plain HLS master playlist URL. The signed
// URL expires in ~4h, so the player must fetch fresh on every play and
// must never cache it long-term (Cache-Control: no-store below).
// ---------------------------------------------------------------------------
const GAANA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const GAANA_KEY = new TextEncoder().encode('gy1t#b@jl(b$wtme');

async function gaanaPost(url) {
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'user-agent': GAANA_UA,
                referer: 'https://gaana.com/',
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
            },
            // CRITICAL: an empty body is rejected by Akamai ("Bad Request").
            body: 'a=1',
        });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

async function gaanaDecrypt(message) {
    try {
        const msg = String(message || '').trim();
        const off = parseInt(msg[0], 10);
        if (!Number.isFinite(off) || off < 0) return '';
        const iv = new TextEncoder().encode(msg.slice(off, off + 16));
        const b64 = msg.slice(off + 16);
        const ct = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('raw', GAANA_KEY, { name: 'AES-CBC' }, false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
        let bytes = new Uint8Array(plain);
        const pad = bytes[bytes.length - 1];
        if (pad >= 1 && pad <= 16 && bytes.slice(-pad).every((b) => b === pad)) bytes = bytes.slice(0, -pad);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return '';
    }
}

const gaanaNorm = (s) =>
    String(s || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
const gaanaTokens = (s) => new Set(gaanaNorm(s).split(' ').filter(Boolean));
function gaanaScore(wantTitle, wantArtist, wantDur, cand) {
    const ct = gaanaNorm(cand.title);
    const wt = gaanaNorm(wantTitle);
    const dur0 = Number(cand.duration) || 0;
    const diff0 = wantDur > 0 && dur0 > 0 ? Math.abs(dur0 - wantDur) : null;
    let titleScore = 0;
    if (ct && wt) {
        if (ct === wt) titleScore = 100;
        else if (ct.includes(wt) || wt.includes(ct)) {
            // Same-name versions: Gaana often suffixes the real version
            // ("Tum Hi Ho (Remix By Dj Shadow...)") while the plain title
            // is a different recording. If the duration also matches
            // within 10s, the suffixed title IS the requested version —
            // score it as exact, or the plain title (wrong recording,
            // duration off by 20s+) wins on title alone.
            titleScore = diff0 !== null && diff0 <= 10 ? 100 : 85;
        } else {
            const a = gaanaTokens(wt),
                b = gaanaTokens(ct);
            const common = [...a].filter((t) => b.has(t)).length;
            titleScore = (common / Math.max(a.size, b.size, 1)) * 80;
        }
    }
    // Artist is scored per artist entity, not against the joined string:
    // "Queen" must not match "Queen Esther" as an exact artist (subset = 25),
    // while "Arijit Singh" inside "Mithoon, Arijit Singh" is exact (50).
    let artistScore = 0;
    if (wantArtist) {
        const want = gaanaTokens(wantArtist);
        for (const name of cand.artists || []) {
            const have = gaanaTokens(name);
            const common = [...want].filter((t) => have.has(t)).length;
            if (common === want.size && common === have.size) artistScore = Math.max(artistScore, 50);
            else if (common === want.size && common < have.size) artistScore = Math.max(artistScore, 25);
            else artistScore = Math.max(artistScore, (common / Math.max(want.size, 1)) * 30);
        }
    }
    const dur = Number(cand.duration) || 0;
    const diff = wantDur > 0 && dur > 0 ? Math.abs(dur - wantDur) : null;
    if (diff !== null && diff > 90) return { total: -1, titleScore, artistScore };
    // A same-title track by a different artist is NOT a match — covers
    // (e.g. "Bohemian Rhapsody" by a cover act, duration near the
    // original's) must not slip through on title + duration alone.
    // Only an exact artist name in Gaana's artist list counts.
    if (wantArtist && artistScore < 50) {
        return { total: -1, titleScore, artistScore };
    }
    const total = titleScore + artistScore - (diff !== null ? diff * 0.2 : 0);
    return { total, titleScore, artistScore };
}

/** Score + decrypt a list of songDetail responses, keeping the best. */
async function gaanaBestFromDetails(details, wantTitle, wantArtist, wantDur, best) {
    for (const d of details) {
        for (const t of d?.tracks || []) {
            const msg = t?.urls?.medium?.message;
            if (!msg) continue;
            const base = await gaanaDecrypt(msg);
            if (!base || !base.startsWith('https://')) continue;
            const artists = (t.artist || []).map((a) => a.name).filter(Boolean);
            const cand = {
                title: t.track_title || '',
                artist: artists.join(', '),
                artists,
                duration: Number(t.duration) || 0,
                seokey: t.seokey || '',
            };
            const { total } = gaanaScore(wantTitle, wantArtist, wantDur, cand);
            if (total < 0) continue;
            if (!best || total > best.score) {
                best = {
                    score: total,
                    title: cand.title,
                    artist: cand.artist,
                    duration: cand.duration,
                    seokey: cand.seokey,
                    stream_url_64: base,
                    stream_url: base.includes('64.mp4') ? base.replace('64.mp4', '128.mp4') : base,
                    stream_url_320: base.includes('64.mp4') ? base.replace('64.mp4', '320.mp4') : base,
                    source: 'gaana',
                };
            }
        }
    }
    return best;
}

/** Gaana's song-page slug for a title, e.g. "Mah Ke Dekha Dem" -> "mah-ke-dekha-dem". */
function gaanaSlug(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Resolve a title+artist to Gaana's best matching track + HLS stream URL. */
async function gaanaResolve(query, wantTitle, wantArtist, wantDur, wantAlbum) {
    // Step 1 — search by TITLE ONLY, using ALL results, not just the
    // top few: same-name versions live far down the ranking (the
    // correct artist's cut is often at position 20+, while the most
    // popular cut sits at the top). Every candidate is scored by
    // exact artist + duration, so extra candidates can't steal the
    // match — they only give the right version a chance to be found.
    // Gaana's search degrades badly with "title artist" phrases for
    // some songs, so that search runs as a second, separate pass and
    // its candidates are scored the same way (garbage is rejected
    // by the exact-artist gate, never returned).
    const keyword = wantTitle || query;
    let best = null;
    for (const kw of [keyword, wantTitle && wantArtist ? `${wantTitle} ${wantArtist}` : null].filter(Boolean)) {
        try {
            const search = await gaanaPost(
                `https://gaana.com/apiv2?country=IN&page=0&secType=track&type=search&keyword=${encodeURIComponent(kw)}`
            );
            const seos = ((search?.gr?.[0]?.gd) || []).map((x) => x?.seo).filter(Boolean);
            if (seos.length) {
                const details = await Promise.all(
                    seos.map((seo) =>
                        gaanaPost(`https://gaana.com/apiv2?type=songDetail&seokey=${encodeURIComponent(seo)}`)
                    )
                );
                best = await gaanaBestFromDetails(details, wantTitle, wantArtist, wantDur, best);
            }
        } catch (e) {
            /* fall through to the next pass */
        }
    }
    // No early return here, on purpose: a good search hit (score 145,
    // duration off by 25s) must not beat a slug hit that is the exact
    // recording (score 150, duration exact). All passes run and the
    // BEST score across every pass wins.

    // Step 2 — direct song-page slugs. Gaana's title search is a
    // ranking, not an index: it buries real tracks (it never listed
    // "Mah Ke Dekha Dem" at all), but the song page itself is just
    // gaana.com/song/<slug>. Proven cases:
    //   "mah-ke-dekha-dem-1"  -> Pawan Singh, 223s (the Waxline version;
    //                            plain "mah-ke-dekha-dem" is a 217s cut)
    //   "kesariya-from-brahmastra" -> Arijit Singh, 268s
    //   "bohemianrhapsody"    -> Queen, Remastered 2011, 358s
    // All candidates are scored the same way and the BEST wins, so a
    // wrong-slug hit (e.g. "kesariya" -> Ustad Sultan Khan) is rejected
    // by the exact-artist gate, never returned.
    const titleSlug = gaanaSlug(wantTitle);
    const albumSlug = gaanaSlug(wantAlbum);
    const slugCandidates = [];
    if (titleSlug) {
        slugCandidates.push(titleSlug);
        slugCandidates.push(titleSlug.replace(/-/g, ''));
        slugCandidates.push(`${titleSlug}-1`);
        if (albumSlug) {
            slugCandidates.push(`${titleSlug}-from-${albumSlug}`);
            slugCandidates.push(`${titleSlug}-from-${albumSlug}-1`);
            slugCandidates.push(`${titleSlug}-${albumSlug}`);
        }
    }
    const uniqueSlugs = [...new Set(slugCandidates)];
    if (uniqueSlugs.length) {
        try {
            const details = await Promise.all(
                uniqueSlugs.map((seo) =>
                    gaanaPost(`https://gaana.com/apiv2?type=songDetail&seokey=${encodeURIComponent(seo)}`)
                )
            );
            best = await gaanaBestFromDetails(details, wantTitle, wantArtist, wantDur, best);
        } catch (e) {
            /* slug lookup is best-effort */
        }
    }
    // Require a real title match, not just an artist coincidence.
    if (!best || best.score < 80) return null;
    return best;
}

export default async (request) => {
    const url = new URL(request.url);

    // Gaana playback resolver: fresh signed HLS URL for a title+artist.
    // Never cached (the signature expires in ~4h).
    if (url.pathname === '/octave/gaana') {
        const title = url.searchParams.get('title') || '';
        const artist = url.searchParams.get('artist') || '';
        const q = url.searchParams.get('q') || `${title} ${artist}`.trim();
        if (!q) return new Response('missing q', { status: 400 });
        const dur = Number(url.searchParams.get('dur') || 0) || 0;
        const album = url.searchParams.get('album') || '';
        const res = await gaanaResolve(q, title, artist, dur, album);
        if (!res) return new Response('no gaana match', { status: 404 });
        return Response.json(res, { headers: { 'Cache-Control': 'no-store' } });
    }

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
