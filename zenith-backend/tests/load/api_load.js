import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Zenith Load Testing Script (k6)
 * Run: k6 run tests/load/api_load.js -e SCENARIO=load -e API_URL=http://localhost:1337
 */

const API_URL = __ENV.API_URL || 'http://localhost:1337';
const SCENARIO = __ENV.SCENARIO || 'smoke'; // smoke | load | stress | spike

// Custom metrics
const createInvoiceTrend = new Trend('create_invoice_duration');
const queryInvoiceTrend = new Trend('query_invoice_duration');
const errorRate = new Rate('errors');

const optionsMap = {
  smoke: {
    vus: 1,
    duration: '30s',
    thresholds: {
      http_req_duration: ['p(95)<200'], 
      errors: ['rate<0.01'], 
    },
  },
  load: {
    vus: 100,
    duration: '60s',
    thresholds: {
      http_req_duration: ['p(95)<300'],
      errors: ['rate<0.01'],
    },
  },
  stress: {
    vus: 500,
    duration: '60s',
    thresholds: {
      http_req_duration: ['p(95)<500'],
      errors: ['rate<0.05'], 
    },
  },
  spike: {
    stages: [
      { duration: '10s', target: 1000 }, 
      { duration: '10s', target: 1000 },
      { duration: '10s', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000'],
      errors: ['rate<0.1'],
    },
  },
};

export const options = optionsMap[SCENARIO];

export default function () {
  const headers = { 'Content-Type': 'application/json', 'X-Parse-Application-Id': 'zenith-production' };

  // 1. Health Check
  const healthRes = http.get(`${API_URL}/health`, { headers });
  check(healthRes, { 'health is 200': (r) => r.status === 200 });

  // 2. Ping Function
  const pingRes = http.post(`${API_URL}/functions/ping`, JSON.stringify({}), { headers });
  check(pingRes, { 'ping is 200': (r) => r.status === 200 });
  if (pingRes.status !== 200) errorRate.add(1);

  // 3. Create Invoice
  const invoicePayload = JSON.stringify({
    customer: `CUST-${__VU}-${__ITER}`,
    lines: [{ qty: 1, unitPrice: 100, description: "Test Load" }],
    total: 100
  });
  const createRes = http.post(`${API_URL}/classes/Invoice`, invoicePayload, { headers });
  createInvoiceTrend.add(createRes.timings.duration);
  check(createRes, { 'create invoice is 201': (r) => r.status === 201 });
  if (createRes.status !== 201) errorRate.add(1);

  // 4. Query Invoice
  const queryRes = http.get(`${API_URL}/classes/Invoice?limit=10`, { headers });
  queryInvoiceTrend.add(queryRes.timings.duration);
  check(queryRes, { 'query invoice is 200': (r) => r.status === 200 });
  if (queryRes.status !== 200) errorRate.add(1);

  // 5. Grafana DS /timeseries/search
  const searchRes = http.post(`${API_URL}/timeseries/search`, JSON.stringify({ target: "test" }), { headers });
  check(searchRes, { 'timeseries search is 200': (r) => r.status === 200 });
  
  sleep(1);
}
