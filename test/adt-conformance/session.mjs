import assert from 'node:assert/strict';
export class Session {
  constructor(base, {timeout = 30000, headers = {}} = {}) {
    this.base = base.replace(/\/$/, '').replace(/\/sap\/bc\/adt$/, '');
    this.timeout = timeout;
    this.headers = headers;
    this.cookies = new Map();
  }
  async request({method = 'GET', path, query, headers = {}, body, timeout = this.timeout}) {
    const url = new URL(path.startsWith('/sap/') ? path : '/sap/bc/adt' + path, this.base);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const res = await fetch(url, {method, redirect: 'manual', signal: AbortSignal.timeout(timeout), body,
      headers: {...this.headers, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(this.token ? {'x-csrf-token': this.token} : {}), 'x-sap-adt-sessiontype': 'stateful', ...headers}});
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], split = pair.indexOf('=');
      if (/max-age=0/i.test(cookie)) this.cookies.delete(pair.slice(0, split));
      else this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return {status: res.status, headers: res.headers, bytes, body: bytes.toString('utf8')};
  }
  async login() {
    const res = await this.request({method: 'HEAD', path: '/core/discovery', headers: {'x-csrf-token': 'fetch'}});
    this.handshakeResponse = res;
    assert.equal(res.status, 200, 'CSRF handshake status');
    this.token = res.headers.get('x-csrf-token');
    assert.ok(this.token && this.token.toLowerCase() !== 'required', 'CSRF token missing');
    assert.ok(this.cookies.size, 'session cookies missing');
    return this;
  }
  async close() {
    if (this.cookies.size) {
      const res = await this.request({path: '/sap/public/bc/icf/logoff'});
      assert.equal(res.status, 200, 'logoff status');
      this.cookies.clear();
    }
  }
}
