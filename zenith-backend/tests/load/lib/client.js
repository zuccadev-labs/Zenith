// k6 shared helpers for Zenith load tests
// Usage: import { createClass, login, send } from './lib/client.js';

import http from 'k6/http';
import { check, fail } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.ZENITH_URL || 'http://localhost:8080';
const APP_ID = __ENV.ZENITH_APP_ID || 'loadtest-app';
const MASTER_KEY = __ENV.ZENITH_MASTER_KEY || 'loadtest-master-key';

export const config = {
  baseUrl: BASE_URL,
  appId: APP_ID,
  masterKey: MASTER_KEY,
  headers: {
    'X-Parse-Application-Id': APP_ID,
    'Content-Type': 'application/json',
  },
  masterHeaders: {
    'X-Parse-Application-Id': APP_ID,
    'X-Parse-Master-Key': MASTER_KEY,
    'Content-Type': 'application/json',
  },
};

export function url(path) {
  return `${BASE_URL}${path}`;
}

export function get(path, params = {}) {
  return http.get(url(path), { headers: config.headers, ...params });
}

export function post(path, body, params = {}) {
  return http.post(url(path), JSON.stringify(body), {
    headers: config.headers,
    ...params,
  });
}

export function put(path, body, params = {}) {
  return http.put(url(path), JSON.stringify(body), {
    headers: config.headers,
    ...params,
  });
}

export function del(path, params = {}) {
  return http.del(url(path), null, { headers: config.headers, ...params });
}

export function postMaster(path, body, params = {}) {
  return http.post(url(path), JSON.stringify(body), {
    headers: config.masterHeaders,
    ...params,
  });
}

export function putMaster(path, body, params = {}) {
  return http.put(url(path), JSON.stringify(body), {
    headers: config.masterHeaders,
    ...params,
  });
}

export function delMaster(path, params = {}) {
  return http.del(url(path), null, { headers: config.masterHeaders, ...params });
}

export function expectStatus(res, expected, label) {
  const ok = check(res, {
    [`${label} status ${expected}`]: (r) => r.status === expected,
  });
  if (!ok) {
    fail(`expected ${expected} got ${res.status} body=${res.body} url=${res.url}`);
  }
}

export function randString(len = 12) {
  return Math.random().toString(36).slice(2, 2 + len);
}

export function randEmail() {
  return `loadtest-${randString(8)}@zenith.test`;
}
