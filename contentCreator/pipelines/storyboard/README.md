# Storyboard Pipeline
### `contentCreator/pipelines/storyboard`

> **[ N8N PIPELINE : v1.0.0 ]** · Part of the Content Creator™ Platform v2.0.0

---

## What Does This Do?

The **Storyboard Pipeline** takes a project you've created in Content Creator™ and automatically generates **15 cinematic storyboard frames** for it — complete with rendered images and production metadata — without any manual work on your part.

You fill in your project details, click **Generate Storyboard**, and the pipeline takes it from there. Frames appear on your screen one by one as they complete. When all 15 are done, your storyboard is ready to review.

That's it. No prompting. No waiting around. No manual image generation. The whole thing runs on autopilot.

---

## How It Works (The Big Picture)

Here's the journey your project takes from click to completed storyboard:

```
You click "Generate Storyboard"
        │
        ▼
 [ Frontend ]  Validates your project fields → fires the pipeline
        │
        ▼
 [ Backend ]   Signs the request with a secure key → sends it to n8n
        │
        ▼
 [ n8n Stage 1 ]  Webhook Trigger — receives & verifies the request
        │
        ▼
 [ n8n Stage 2 ]  Prompt Generation — an LLM reads your project and
                  writes 15 unique, cinematically composed image prompts
        │
        ▼
 [ n8n Stage 3 ]  Image Generation Loop — Google Imagen 4 renders each
                  prompt as a 4K vertical (9:16) still image
        │
        ▼
 [ n8n Stage 4 ]  Per-Frame Callback — each completed frame is sent back
                  to your Wix backend immediately (not batched at the end)
        │
        ▼
 [ Backend ]   Verifies the frame, saves it to the database, broadcasts
               progress to your UI
        │
        ▼
 [ Frontend ]  Frame appears on your screen ✓  (×15, one by one)
        │
        ▼
 [ Done ]  storyboardStatus → "complete"
```

The whole thing is **asynchronous** — n8n does its work in the background, and your frontend stays live and responsive the whole time.

---

## What's in This Directory

```
contentCreator/pipelines/storyboard/
│
├── README.md                        ← You are here
│
├── storyboard__v1_0_0.json          ← The n8n workflow file. Import this
│                                       into your n8n instance to get the
│                                       full pipeline up and running.
│
├── phase_03_part_01__prompt-gen-node.docx
│   └── Spec for Stage 2: how the LLM generates your 15 prompts,
│       what fields it reads, what the output schema looks like,
│       and how errors are handled.
│
├── phase_03_part_02__image-generation-loop.docx
│   └── Spec for Stage 3: how Imagen 4 is called for each prompt,
│       retry logic, rate limit handling, and the 9:16 / 4K output
│       requirements.
│
└── phase_03_part_03__PerFrameCallback.docx
    └── Spec for Stage 4: how each completed frame gets delivered
        back to your Wix backend, HMAC signing, payload schema,
        and what happens when a callback fails.
```

> **New to the project?** Start with `storyboard__v1_0_0.json` (import into n8n), then read the three Part docs in order if you need to understand, modify, or debug any stage.

---

## Before You Start

You need four things set up before this pipeline will run:

### 1. A Wix Site with Velo Enabled
The backend lives in Wix. If you don't have Velo turned on, go to your Wix dashboard → Settings → Velo by Wix and enable it.

### 2. An n8n Instance
n8n is the automation engine that runs the pipeline. You can use [n8n Cloud](https://n8n.io) or self-host it. Either works.

### 3. A Google Cloud Project with Vertex AI
The pipeline uses **Google Imagen 4** to generate images. You'll need:
- A Google Cloud project
- Vertex AI API enabled
- A service account with the `Vertex AI User` role and a downloaded JSON key

### 4. An LLM API Key
The prompt generation stage calls a large language model (Claude, GPT-4, or compatible) to write your 15 image prompts. Have your API key ready.

---

## Setup Guide

Follow these steps in order. **Don't skip ahead** — each step is a prerequisite for the next.

---

### Step 1 — Create Your Secrets (Do This First)

**Never hardcode credentials anywhere in the codebase.** All secrets live in two vaults:

**In Wix Secrets Manager** (your Wix dashboard → Settings → Secrets Manager):

| Secret Name | What to Put There |
|---|---|
| `N8N_STORYBOARD_WEBHOOK_URL` | The webhook trigger URL from your n8n workflow (you'll get this in Step 3) |
| `N8N_CALLBACK_SECRET_KEY` | A random string, 32+ characters long. Generate one [here](https://generate.plus/en/base64) or with `openssl rand -base64 32` in your terminal. |

**In your n8n credential vault:**

| Credential | What to Put There |
|---|---|
| Google Cloud Service Account | The JSON key file for your Vertex AI service account |
| `N8N_CALLBACK_SECRET_KEY` | The **exact same value** as above — these must match |
| `WIX_RECEIVE_FRAMES_URL` | The URL of your `receiveFrames()` Wix endpoint (you'll get this in Step 2) |
| `GCP_PROJECT_ID` | Your Google Cloud project ID |
| `GCP_REGION` | The region your Vertex AI is in (e.g., `us-central1`) |

> ⚠️ The `N8N_CALLBACK_SECRET_KEY` must be **identical** in both Wix and n8n. This is the shared secret that lets your backend verify that callbacks are really coming from your pipeline and not from somewhere else.

---

### Step 2 — Set Up the Database

In **Wix CMS**, create a new collection called `storyboard_frames` with these fields:

| Field Name | Type | What It Stores |
|---|---|---|
| `projectId` | Text | Which project these frames belong to |
| `owner` | Text | The Wix Member ID of the project owner (keeps users' data separate) |
| `frameIndex` | Number | The frame's position in the storyboard (0 through 14) |
| `imageUrl` | Text | Where the rendered image lives in Wix Media |
| `promptText` | Text | The text-to-image prompt that generated this frame |
| `frameData` | Object | Composition, lighting, camera angle, mood, and CTA metadata |
| `status` | Text | `pending`, `complete`, or `failed` |

Also make sure your existing `projects` collection has these two fields (add them if they're missing):

| Field Name | Type |
|---|---|
| `storyboardStatus` | Text (`idle` / `generating` / `complete` / `failed`) |
| `frameCount` | Number |

---

### Step 3 — Import the n8n Workflow

1. Open your n8n instance
2. Go to **Workflows → Import**
3. Upload `storyboard__v1_0_0.json` from this directory
4. Once imported, open the workflow and copy the **Webhook Trigger URL** (it'll look like `https://your-n8n.com/webhook/...`)
5. Paste that URL into the `N8N_STORYBOARD_WEBHOOK_URL` secret you created in Step 1

---

### Step 4 — Deploy the Backend Services

Deploy the three Wix Velo webMethods from `/backend/services/` in your repo:

| Function | What It Does |
|---|---|
| `generateStoryboard()` | Called when the user clicks Generate. Validates the project, signs the payload with HMAC, and fires the webhook to n8n. |
| `receiveFrames()` | Called by n8n after each frame renders. Verifies the HMAC signature, checks that the frame belongs to the right user, writes it to the database, and broadcasts progress to the frontend. |
| `getStoryboardFrames()` | Called by the polling service on the frontend. Returns all frames for a project — but only if the requesting user owns that project. |

---

### Step 5 — Test End-to-End

1. Create a test project in your dashboard and fill in **all required fields**: Title, Description, Goal, Offer, Target Audience, and Misconception.
2. Click **Generate Storyboard**.
3. Watch for frames to appear progressively on the project detail page.
4. In your n8n execution log, you should see entries like: `[ N8N PIPELINE : v1.0.0 ] requestId=... frameIndex=0`
5. When frame 14 arrives, the project's `storyboardStatus` should change to `complete`.

If all 15 frames appear and the status flips to `complete`, your pipeline is working. 🎉

---

## The Pipeline Stages in Detail

| Stage | Name | What Happens |
|---|---|---|
| **1** | Webhook Trigger | n8n receives the signed payload from Wix, validates the HMAC signature, and extracts all project fields. If the signature is invalid, the pipeline stops here. |
| **2** | Prompt Generation | An LLM reads your project context (company, goal, offer, audience, etc.) and writes 15 distinct, cinematically composed text-to-image prompts. Each prompt has a different visual concept — no two are alike. |
| **3** | Image Generation Loop | Imagen 4 renders each prompt as a 9:16 vertical image at 4K resolution. Frames are processed sequentially. If a generation fails, it retries up to 3 times with exponential backoff before marking that frame as failed. |
| **4** | Per-Frame Callback | As soon as each image URL is confirmed, the pipeline immediately calls `receiveFrames()` on your Wix backend. It doesn't wait for all 15 — each frame is delivered the moment it's ready. |
| **5** | Error Handling | If any stage fails persistently, the pipeline logs the failure with the stage name and frame index, then sends a failure callback so your backend can update the project status and let the user know. |

---

## Project Fields Required

The pipeline can't generate a storyboard without all of these fields. If any are missing, the backend will reject the request before it ever reaches n8n.

| Field | Example | Why It Matters |
|---|---|---|
| `companyName` | Rent-A-Chicken Co. | Grounds the visual identity of the frames |
| `companyDescription` | Seasonal backyard chicken rentals | Gives the LLM context for tone and subject matter |
| `primaryCategory` | General Services | Selects the right visual template style |
| `customerType` | `b2c` | Frames the audience for prompt writing |
| `title` | Backyard egg revolution | Sets the campaign headline and creative direction |
| `goal` | `sentiment-shift` | Determines the narrative arc across all 15 frames |
| `offer` | `new-flagship-product` | Shapes the CTA framing for the storyboard |
| `misconception` | `complexity-ease-of-use` | Drives the pain-point narrative |
| `targetAudience` | `next-gen-gen-z-millennials` | Guides visual and tonal style |

---

## What Could Go Wrong (And What Happens)

The pipeline is designed to **never fail silently**. Here's what each failure looks like and what the system does about it:

| Scenario | What Happens |
|---|---|
| n8n is unreachable when you click Generate | The project status updates to `failed` and a retry button appears in the UI |
| An image generation call fails | The pipeline retries up to 3 times with exponential backoff. If it still fails, that frame is marked `failed` and the pipeline continues with the remaining frames |
| n8n sends the same frame twice | `receiveFrames()` detects the duplicate and responds with `ok: true, written: false`. No duplicate record is created |
| The HMAC signature on a callback is wrong | The callback is rejected with HTTP 403. The error is logged. No data is written |
| Polling runs for 10 minutes without completing | The UI shows a graceful timeout message. The user can retry |

---

## Compliance & Governance

This pipeline operates under three governing documents. All changes must remain in compliance:

| Document | What It Covers |
|---|---|
| [AI Governance Framework v1.0](../../docs/ai-governance-framework.pdf) | LLM controls, security requirements, human oversight triggers, audit standards |
| [Platform Standards v2.0](../../docs/platform-standards.pdf) | Architecture patterns, versioning, reliability rules, logging format |
| [SaaS Infrastructure Compliance Model](../../docs/saas-infrastructure-compliance-model.pdf) | Secrets management, observability, deployment gates, SOC2 alignment |

### Key Rules for Contributors

If you modify any part of this pipeline, you must:

- **Version your component** — every module carries a `[ COMPONENT NAME : vX.X.X ]` tag in its logs
- **Log everything** — each execution must include a `requestId`, the component version tag, stage name, and timestamps
- **Never hardcode secrets** — zero credentials in source code, ever
- **Use the standard error format** for all failures:
  ```json
  {
    "ok": false,
    "status": 403,
    "error": {
      "type": "INVALID_SIGNATURE",
      "message": "Request signature could not be verified."
    }
  }
  ```
- **Increment `contractVersion`** on any payload schema change and maintain backward compatibility

### When to Escalate to a Human

Human intervention is required if:
- The pipeline fails repeatedly beyond retry thresholds
- A security anomaly is detected (e.g., repeated HMAC failures from unexpected sources)
- Output deviates from brand or compliance constraints

---

## Component Versions

| Component | Version | Log Prefix |
|---|---|---|
| n8n Storyboard Pipeline | v1.0.0 | `[ N8N PIPELINE : v1.0.0 ]` |
| Prompt Generation Node | v1.0.0 | `[ PROMPT GEN : v1.0.0 ]` |
| Image Generation Loop | v1.0.0 | `[ N8N IMAGE GENERATION LOOP : v1.0.0 ]` |
| `generateStoryboard()` | v1.0.0 | `[ GENERATE STORYBOARD : v1.0.0 ]` |
| `receiveFrames()` | v1.0.0 | `[ RECEIVE FRAMES : v1.0.0 ]` |
| `getStoryboardFrames()` | v1.0.0 | `[ GET STORYBOARD FRAMES : v1.0.0 ]` |
| `storyboard-poller.js` | v1.0.0 | `[ STORYBOARD POLLER : v1.0.0 ]` |
| `project-detail.page.js` | v2.0.0 | `[ PROJECT DETAIL PAGE : v2.0.0 ]` |

---

## Related Directories

| Path | What's There |
|---|---|
| `/backend/services/` | The three Wix webMethods that power the backend |
| `/public/utils/storyboard-poller.js` | The frontend polling utility that watches for new frames |
| `/page_code/dashboard/project-detail.page.js` | The project detail page controller (v2.0.0) |
| `/docs/` | Governance and compliance framework documents |

---

*Content Creator™ · Storyboard Pipeline v1.0.0 · Governed under AI Framework v1.0 · Platform Standards v2.0*