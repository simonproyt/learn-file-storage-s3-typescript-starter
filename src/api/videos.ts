import path from "path";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

function getFileExtension(mediaType: string) {
  switch (mediaType) {
    case "video/mp4":
      return "mp4";
    default:
      return undefined;
  }
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1 GB
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file is too large");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid video type");
  }

  const extension = getFileExtension(file.type);
  if (!extension) {
    throw new BadRequestError("Unsupported video type");
  }

  const key = `${randomBytes(32).toString("hex")}.${extension}`;
  const tempPath = path.join(tmpdir(), key);
  const data = await file.arrayBuffer();
  await Bun.write(tempPath, new Uint8Array(data));

  try {
    await cfg.s3Client.write(key, Bun.file(tempPath), {
      contentType: file.type,
    });
  } finally {
    await Bun.file(tempPath).unlink();
  }

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
