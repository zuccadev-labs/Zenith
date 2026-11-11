// Mixed-workload scenario — simulates real client traffic patterns
// Run: k6 run scenarios/mixed.js

import { check, sleep } from "k6";
import { del, expectStatus, get, post, put, randEmail, randString } from "../lib/client.js";

export const options = {
  scenarios: {
    auth_flow: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "5m", target: 100 },
        { duration: "1m", target: 0 },
      ],
      exec: "authFlow",
    },
    crud_workload: {
      executor: "constant-arrival-rate",
      rate: 200,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: "crudWorkload",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<400"],
    http_req_failed: ["rate<0.01"],
  },
};

export function authFlow() {
  const email = randEmail();
  const password = "P@ssw0rd!-" + randString(8);
  const signupRes = post("/users", { username: email, password, email });
  expectStatus(signupRes, 201, "signup");
  sleep(1);
  const loginRes = post("/login", { username: email, password });
  expectStatus(loginRes, 200, "login");
  sleep(2);
}

export function crudWorkload() {
  const createRes = post("/classes/LoadTest_Item", {
    name: `item-${randString(6)}`,
    value: Math.random(),
  });
  expectStatus(createRes, 201, "create");
  const id = createRes.json("objectId");
  sleep(0.1);
  get(`/classes/LoadTest_Item/${id}`);
  sleep(0.1);
  put(`/classes/LoadTest_Item/${id}`, { value: Math.random() });
  sleep(0.1);
  del(`/classes/LoadTest_Item/${id}`);
}
