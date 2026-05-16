import path from "path";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new BadRequestError(
      `Failed to analyze video: ${stderrText.trim() || `ffprobe exited ${exitCode}`}`,
    );
  }

  let metadata;
  try {
    metadata = JSON.parse(stdoutText);
  } catch {
    throw new BadRequestError("Unable to parse video metadata");
  }

  const stream = metadata?.streams?.[0];
  if (!stream || typeof stream.width !== "number" || typeof stream.height !== "number") {
    throw new BadRequestError("Unable to determine video dimensions");
  }

  const width = stream.width;
  const height = stream.height;
  const ratio = width / height;
  const landscapeRatio = 16 / 9;
  const portraitRatio = 9 / 16;
  const tolerance = 0.03;

  if (Math.abs(ratio - landscapeRatio) < tolerance) {
    return "landscape";
  }

  if (Math.abs(ratio - portraitRatio) < tolerance) {
    return "portrait";
  }

  return "other";
}

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stderrText = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new BadRequestError(
      `Failed to process video for fast start: ${stderrText.trim() || `ffmpeg exited ${exitCode}`}`,
    );
  }

  return outputFilePath;
}

function getFileExtension(mediaType: string) {
  switch (mediaType) {
    case "video/mp4":
      return "mp4";
    default:
      return undefined;
  }
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return cfg.s3Client.presign(key, { expiresIn: expireTime });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  const videoKey = video.videoURL
    ? video.videoURL.startsWith("http")
      ? new URL(video.videoURL).pathname.slice(1)
      : video.videoURL
    : undefined;

  if (!videoKey) {
    return video;
  }

  return {
    ...video,
    videoURL: generatePresignedURL(cfg, videoKey, 60),
  };
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

  const tempFilename = `${randomBytes(32).toString("hex")}.${extension}`;
  const tempPath = path.join(tmpdir(), tempFilename);
  const data = await file.arrayBuffer();
  await Bun.write(tempPath, new Uint8Array(data));

  let processedPath = "";
  try {
    processedPath = await processVideoForFastStart(tempPath);
  } finally {
    await Bun.file(tempPath).unlink();
  }

  const aspect = await getVideoAspectRatio(processedPath);
  const key = `${aspect}/${randomBytes(32).toString("hex")}.${extension}`;

  try {
    await cfg.s3Client.write(key, Bun.file(processedPath), {
      contentType: file.type,
    });
  } finally {
    if (processedPath) {
      await Bun.file(processedPath).unlink();
    }
  }

  video.videoURL = key;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, dbVideoToSignedVideo(cfg, video));
}
