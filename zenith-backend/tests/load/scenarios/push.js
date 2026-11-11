// Push scenario — send push notifications to installations
// Run: k6 run scenarios/push.js

import { check, sleep } from "k6";
import { expectStatus, get, post, postMaster, randString } from "../lib/client.js";

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    "http_req_duration{scenario:push}": ["p(95)<400"],
    "http_req_duration{scenario:install}": ["p(95)<200"],
    http_req_failed: ["rate<0.01"],
  },
};

const CHANNELS = ["news", "alerts", "updates"];

export function setup() {
  for (const ch of CHANNELS) {
    post("/push_audiences", { name: `loadtest-${ch}`, query: { channels: ch } });
  }
}

export default function () {
  // 1. Register installation
  const installRes = post("/installations", {
    deviceType: "web",
    channels: [CHANNELS[Math.floor(Math.random() * CHANNELS.length)]],
    installationId: `dev-${randString(12)}`,
  });
  expectStatus(installRes, 201, "install");

  sleep(0.5);

  // 2. Send push to a channel
  const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
  const pushRes = post("/push", {
    channels: [channel],
    data: {
      alert: `Load test ${randString(6)}`,
      title: "Zenith",
    },
  });
  expectStatus(pushRes, 200, "push");
  check(pushRes.json("result"), { "push is true": (v) => v === true });

  sleep(2);
}
