import { Zen } from "@zuccadev-labs/zenith";

// Cloud Jobs (background tasks)
// Use Zen.Cloud.job() to define scheduled / triggered jobs.
// Jobs receive a status function to report progress.

Zen.Cloud.job("myJob", async (request) => {
  const { params, message, log } = request;
  log.info("Job started with params:", params);
  // ... do work ...
  message("Job completed");
});

export { Zen };
