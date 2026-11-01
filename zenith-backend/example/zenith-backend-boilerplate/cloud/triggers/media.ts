import { Zen } from "@zuccadev-labs/zenith";

// Media Triggers
// These fire on streaming media operations (transcoding, thumbnailing, etc.).

// Zen.Cloud.beforeStreamMedia(async (request) => {
//   const { media } = request;
//   if (media.type === "video" && media.size > 100 * 1024 * 1024) {
//     throw new Error("Video too large for streaming");
//   }
// });
//
// Zen.Cloud.afterTranscodeMedia(async (request) => {
//   console.log("Transcoded:", request.media.id, "- variants:", request.variants);
// });

export { Zen };
