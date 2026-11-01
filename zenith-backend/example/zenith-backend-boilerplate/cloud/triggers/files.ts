import { Zen } from "@zuccadev-labs/zenith";

// File Triggers
// These fire on file upload / delete operations.

// Zen.Cloud.beforeSaveFile(async (request) => {
//   const { file } = request;
//   const maxSize = 10 * 1024 * 1024; // 10 MB
//   if (file.size > maxSize) throw new Error("File exceeds maximum size");
//   file.meta = { uploadedBy: request.user?.id ?? "anonymous" };
// });
//
// Zen.Cloud.afterSaveFile(async (request) => {
//   console.log("File saved:", request.file.url);
// });
//
// Zen.Cloud.beforeDeleteFile(async (request) => {
//   const { file } = request;
//   if (file.meta?.protected) throw new Error("Protected file cannot be deleted");
// });

export { Zen };
