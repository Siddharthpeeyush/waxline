// Netlify Edge Function: proxies /octave/* to the Octave API.
export default async (request) => {
    const url = new URL(request.url);
    const target =
        'https://api.octavestreaming.com' + url.pathname.replace(/^\/octave/, '') + url.search;
    const headers = new Headers(request.headers);
    headers.set('user-agent', 'Waxline/1.0');
    headers.delete('referer');
    headers.delete('origin');
    const res = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
    return res;
};
export const config = { path: '/octave/*' };
