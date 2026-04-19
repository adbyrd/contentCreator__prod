// [ FILE NAME : getStoryboardFrames.web.js : v1.0.0 ]
// Domain  : Storyboard
// Layer   : Backend — Polling Read Endpoint
// Purpose : Returns all persisted storyboard frames for a project, ordered by
//           frameIndex ascending. Double-scoped by BOTH projectId AND owner to
//           prevent cross-user data leakage. Also returns the project's current
//           storyboardStatus so the frontend can determine completion without a
//           separate projects query.

import { Permissions, webMethod } from 'wix-web-module';
import wixData                    from 'wix-data';
import { currentMember }         from 'wix-members-backend';

// ─── Constants ────────────────────────────────────────────────────────────────
const VERSION              = '[ GET STORYBOARD FRAMES : v1.0.0 ]';
const FRAMES_COLLECTION    = 'storyboard_frames';
const PROJECTS_COLLECTION  = 'projects';
const MAX_FRAMES           = 15;

// ─── Structured response helpers ─────────────────────────────────────────────
const ok    = (data)                  => ({ ok: true,  status: 200, data });
const fail  = (status, type, message) => ({ ok: false, status, error: { type, message } });

// ─── getStoryboardFrames ──────────────────────────────────────────────────────
export const getStoryboardFrames = webMethod(
  Permissions.Member,
  async (projectId) => {
    const requestId = `gsf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`${VERSION} [${requestId}] getStoryboardFrames() invoked — projectId: ${projectId}`);

    // ── 1. Input validation ──────────────────────────────────────────────────
    if (!projectId || typeof projectId !== 'string' || !projectId.trim()) {
      console.warn(`${VERSION} [${requestId}] Missing or invalid projectId`);
      return fail(400, 'VALIDATION_ERROR', 'projectId is required.');
    }

    // ── 2. Caller identity ───────────────────────────────────────────────────
    let member;
    try {
      member = await currentMember.getMember();
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Member resolution failed: ${err.message}`);
      return fail(401, 'AUTH_ERROR', 'Unable to resolve authenticated member.');
    }

    const callerId = member._id;

    // ── 3. Project ownership check ───────────────────────────────────────────
    let project;
    try {
      project = await wixData.get(PROJECTS_COLLECTION, projectId);
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Project fetch failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to retrieve project data.');
    }

    if (!project) {
      console.warn(`${VERSION} [${requestId}] Project not found: ${projectId}`);
      return fail(404, 'NOT_FOUND', 'Project not found.');
    }

    if (project._owner !== callerId) {
      console.warn(`${VERSION} [${requestId}] Ownership violation — caller: ${callerId}, owner: ${project._owner}`);
      return fail(403, 'FORBIDDEN', 'You do not have permission to access this project\'s storyboard.');
    }

    // ── 4. Double-scoped frame query (projectId AND owner) ───────────────────
    let frames;
    try {
      const queryResult = await wixData
        .query(FRAMES_COLLECTION)
        .eq('projectId', projectId)
        .eq('owner', callerId)          // Second scope — prevents cross-user leakage
        .ascending('frameIndex')        // Ordered for consistent UI rendering
        .limit(MAX_FRAMES)
        .find();

      frames = queryResult.items;
    } catch (err) {
      console.error(`${VERSION} [${requestId}] Frame query failed: ${err.message}`);
      return fail(500, 'DATABASE_ERROR', 'Failed to retrieve storyboard frames.');
    }

    console.log(`${VERSION} [${requestId}] Frames retrieved — count: ${frames.length}, status: ${project.storyboardStatus}`);

    // ── 5. Shape response — expose only safe fields ──────────────────────────
    const safeFrames = frames.map(frame => ({
      _id:        frame._id,
      frameIndex: frame.frameIndex,
      imageUrl:   frame.imageUrl,
      promptText: frame.promptText,
      frameData:  frame.frameData  ?? {},
      status:     frame.status,
      receivedAt: frame.receivedAt,
    }));

    return ok({
      projectId,
      storyboardStatus: project.storyboardStatus ?? 'idle',
      frameCount:       safeFrames.length,
      frames:           safeFrames,
    });
  }
);

// ─── Debug export ─────────────────────────────────────────────────────────────
export async function debugGetStoryboardFrames(projectId = 'test-project-id') {
  console.log(`${VERSION} [DEBUG] Simulating getStoryboardFrames for projectId: ${projectId}`);
  return {
    debug: true,
    projectId,
    simulatedStatus: 'generating',
    simulatedFrameCount: 7,
    timestamp: new Date().toISOString(),
  };
}