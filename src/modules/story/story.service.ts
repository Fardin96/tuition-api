import type { FileAsset, Prisma } from "../../generated/prisma/client.js";
import { appError, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { claimFile, discardFile, fileUrl, removeObjects } from "../files/files.service.js";
import { visibleNote } from "../files/upload-review.service.js";
import { wordCount } from "../site-content/site-content.schema.js";
import {
  landingSourceKeys,
  removeSourceFromLanding,
} from "../site-content/site-content.service.js";
import {
  type CreateStoryInput,
  MAX_STORIES,
  STORY_BODY_WORDS,
  type StoryListResponse,
  type StoryResponse,
  TUTOR_STORY_BODY_CHARS,
} from "./story.schema.js";

// A story is reviewed by an admin before it can go on the landing page. The author may keep at most
// MAX_STORIES stories (any status) and have one pending review at a time. The account row is locked
// while a story is sent, so two sends cannot both pass the count.

const storyInclude = { image: true, video: true } as const;
type StoryRow = Prisma.StoryGetPayload<{ include: typeof storyInclude }>;

async function toStory(row: StoryRow, onLanding: boolean): Promise<StoryResponse> {
  const media = async (file: FileAsset | null) =>
    file ? { url: await fileUrl(file), contentType: file.contentType } : null;
  return {
    id: row.id,
    role: row.role,
    headline: row.headline,
    body: row.body,
    status: row.status,
    note: visibleNote(row.moderationNote, row.noteVisible),
    image: await media(row.image),
    video: await media(row.video),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    onLanding,
  };
}

/** The signed-in author's stories, newest first, with the limit state the form needs. */
export async function listStories(accountId: string): Promise<StoryListResponse> {
  const rows = await prisma.story.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: storyInclude,
  });
  const onLanding = await landingSourceKeys();
  const stories = await Promise.all(
    rows.map((row) => toStory(row, onLanding.has(`story:${row.id}`))),
  );

  const blockedReason =
    rows.length >= MAX_STORIES
      ? "LIMIT"
      : rows.some((row) => row.status === "PENDING")
        ? "PENDING"
        : null;
  return { stories, max: MAX_STORIES, canSubmit: blockedReason === null, blockedReason };
}

/** Checks the fields that depend on the author's role. Throws 400 VALIDATION_ERROR with issues. */
function checkForRole(role: "STUDENT" | "TUTOR", input: CreateStoryInput) {
  const issues: { path: string; message: string }[] = [];
  if (role === "STUDENT") {
    if (input.headline === undefined) issues.push({ path: "headline", message: "Required" });
    if (wordCount(input.body) > STORY_BODY_WORDS) {
      issues.push({ path: "body", message: `At most ${STORY_BODY_WORDS} words` });
    }
  } else {
    if (input.headline !== undefined) {
      issues.push({ path: "headline", message: "Tutor stories have no headline." });
    }
    if (input.videoFileId !== undefined) {
      issues.push({ path: "videoFileId", message: "Only students can add a video." });
    }
    if (input.body.length > TUTOR_STORY_BODY_CHARS) {
      issues.push({ path: "body", message: `At most ${TUTOR_STORY_BODY_CHARS} characters` });
    }
  }
  if (issues.length > 0) throw validationIssuesError("Invalid story", issues);
}

/**
 * Sends a story for review. 409 STORY_LIMIT_REACHED at the limit, 409 STORY_PENDING while another
 * story waits for a decision. Each file must be the author's own, finished and not used elsewhere.
 */
export async function createStory(
  accountId: string,
  role: "STUDENT" | "TUTOR",
  input: CreateStoryInput,
): Promise<StoryResponse> {
  checkForRole(role, input);
  const data = {
    accountId,
    role,
    headline: role === "STUDENT" ? (input.headline ?? null) : null,
    body: input.body,
    imageFileId: input.imageFileId ?? null,
    videoFileId: role === "STUDENT" ? (input.videoFileId ?? null) : null,
  };

  let row: StoryRow;
  try {
    row = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
      const existing = await tx.story.findMany({ where: { accountId }, select: { status: true } });
      if (existing.length >= MAX_STORIES) {
        throw appError(
          "StoryLimitReached",
          409,
          `You have ${MAX_STORIES} stories. Delete one to send another.`,
          { limit: MAX_STORIES },
        );
      }
      if (existing.some((story) => story.status === "PENDING")) {
        throw appError(
          "StoryPending",
          409,
          "Wait until your story is reviewed before sending another.",
        );
      }
      if (data.imageFileId) {
        await claimFile(tx, {
          fileId: data.imageFileId,
          ownerAccountId: accountId,
          purpose: "STORY_IMAGE",
        });
      }
      if (data.videoFileId) {
        await claimFile(tx, {
          fileId: data.videoFileId,
          ownerAccountId: accountId,
          purpose: "STORY_VIDEO",
        });
      }
      return tx.story.create({ data: { ...data, consentAt: new Date() }, include: storyInclude });
    });
  } catch (error) {
    // The partial unique index is the backstop for two sends that both passed the count.
    if (error instanceof Error && "code" in error && error.code === "P2002") {
      throw appError(
        "StoryPending",
        409,
        "Wait until your story is reviewed before sending another.",
      );
    }
    throw error;
  }
  return toStory(row, false);
}

/**
 * Deletes one of the author's stories and its files. A card on the landing page that uses the story
 * goes first. Returns false when the story is not the author's. Stored copies go after the commit.
 */
export async function deleteStory(accountId: string, storyId: string): Promise<boolean> {
  const removed = await prisma.$transaction(async (tx) => {
    // The story row is locked first, then the landing lists, then the files: the order a save uses.
    await tx.$queryRaw`SELECT id FROM story WHERE id = ${storyId}::uuid AND account_id = ${accountId}::uuid FOR UPDATE`;
    const story = await tx.story.findFirst({ where: { id: storyId, accountId } });
    if (!story) return null;

    await removeSourceFromLanding(tx, { kind: "story", id: story.id }, accountId);
    await tx.story.delete({ where: { id: story.id } });

    const files: FileAsset[] = [];
    for (const fileId of [story.imageFileId, story.videoFileId]) {
      if (!fileId) continue;
      const file = await discardFile(tx, fileId);
      if (file) files.push(file);
    }
    return files;
  });
  if (!removed) return false;
  await removeObjects(removed);
  return true;
}

/** 403 PROFILE_INCOMPLETE when the signed-in student or tutor has no profile yet. */
export async function requireStoryProfile(accountId: string, role: "STUDENT" | "TUTOR") {
  const found =
    role === "STUDENT"
      ? await prisma.student.findUnique({ where: { accountId }, select: { id: true } })
      : await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!found) {
    throw appError("ProfileIncomplete", 403, "Create your profile before sharing a story.");
  }
}
