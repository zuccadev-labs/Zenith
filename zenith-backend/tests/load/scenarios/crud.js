// CRUD scenario — create, read, update, delete, query
// Run: k6 run scenarios/crud.js

import { check, sleep } from 'k6';
import { post, get, put, del, delMaster, expectStatus, randString } from '../lib/client.js';

const CLASS = 'LoadTest_Item';

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '2m', target: 500 },
    { duration: '1m', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    'http_req_duration{scenario:create}': ['p(95)<200'],
    'http_req_duration{scenario:read}':   ['p(95)<80'],
    'http_req_duration{scenario:update}': ['p(95)<200'],
    'http_req_duration{scenario:delete}': ['p(95)<200'],
    'http_req_duration{scenario:query}':  ['p(95)<250'],
    http_req_failed: ['rate<0.005'],
  },
};

export function setup() {
  // Ensure schema exists (master-key)
  const schemaRes = post(`/schemas/${CLASS}`, {
    className: CLASS,
    fields: {
      name:     { type: 'String' },
      value:    { type: 'Number' },
      category: { type: 'String' },
    },
  });
  check(schemaRes, { 'schema exists or 200/201': (r) => r.status === 200 || r.status === 201 });
}

export function teardown() {
  delMaster(`/schemas/${CLASS}`);
}

export default function () {
  // 1. CREATE
  const createRes = post(`/classes/${CLASS}`, {
    name: `item-${randString(6)}`,
    value: Math.floor(Math.random() * 1000),
    category: ['A', 'B', 'C'][Math.floor(Math.random() * 3)],
  });
  expectStatus(createRes, 201, 'create');
  const id = createRes.json('objectId');
  check(id, { 'create has objectId': (v) => typeof v === 'string' });

  sleep(0.2);

  // 2. READ
  const readRes = get(`/classes/${CLASS}/${id}`);
  expectStatus(readRes, 200, 'read');

  sleep(0.2);

  // 3. UPDATE
  const updateRes = put(`/classes/${CLASS}/${id}`, { value: 42 });
  expectStatus(updateRes, 200, 'update');

  sleep(0.2);

  // 4. QUERY
  const queryRes = get(`/classes/${CLASS}?where=${encodeURIComponent(JSON.stringify({ category: 'A' }))}&limit=10`);
  expectStatus(queryRes, 200, 'query');

  sleep(0.2);

  // 5. DELETE
  const deleteRes = del(`/classes/${CLASS}/${id}`);
  expectStatus(deleteRes, 200, 'delete');

  sleep(0.5);
}
