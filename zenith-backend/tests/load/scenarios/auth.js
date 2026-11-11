// Auth scenario — signup, login, get current user, logout
// Run: k6 run scenarios/auth.js

import http from "k6/http";
import { check, sleep } from "k6";
import {
  config,
  expectStatus,
  get,
  post,
  postMaster,
  randEmail,
  randString,
} from "../lib/client.js";

export const options = {
  stages: [
    { duration: "30s", target: 50 },
    { duration: "1m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    "http_req_duration{scenario:signup}": ["p(95)<300"],
    "http_req_duration{scenario:login}": ["p(95)<150"],
    "http_req_duration{scenario:me}": ["p(95)<80"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const email = randEmail();
  const password = "P@ssw0rd!-" + randString(8);

  // 1. Signup
  const signupRes = post("/users", {
    username: email,
    password: password,
    email: email,
  });
  expectStatus(signupRes, 201, "signup");
  const userId = signupRes.json("objectId");
  const sessionToken = signupRes.json("sessionToken");
  check(userId, { "signup has objectId": (v) => typeof v === "string" });
  check(sessionToken, { "signup has sessionToken": (v) => typeof v === "string" });

  sleep(0.5);

  // 2. Get current user
  const meRes = get("/users/me", {
    headers: { "X-Parse-Session-Token": sessionToken },
  });
  expectStatus(meRes, 200, "me");

  sleep(0.5);

  // 3. Logout
  const logoutRes = http.post(
    `${config.baseUrl}/logout`,
    "{}",
    { headers: { ...config.headers, "X-Parse-Session-Token": sessionToken } },
  );
  expectStatus(logoutRes, 200, "logout");

  sleep(0.5);

  // 4. Login (re-use credentials)
  const loginRes = post("/login", { username: email, password: password });
  expectStatus(loginRes, 200, "login");
  const newSession = loginRes.json("sessionToken");
  check(newSession, { "login has sessionToken": (v) => typeof v === "string" });

  sleep(1);
}
