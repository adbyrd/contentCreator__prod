![Content Creator](/assets/images/github-header.jpg)
# Content Creator™

> **Autonomous 4K video production — from project brief to storyboard in minutes, not weeks.**

[![Version](https://img.shields.io/badge/platform-v2.0.0-blue)](docs/platform-standards.pdf)
[![Governance](https://img.shields.io/badge/governance-AI%20Framework%20v1.0-green)](docs/ai-governance-framework.pdf)
[![Compliance](https://img.shields.io/badge/compliance-SOC2%20aligned-orange)](docs/saas-infrastructure-compliance-model.pdf)
[![Stack](https://img.shields.io/badge/stack-Wix%20Velo%20%7C%20n8n%20%7C%20Google%20Imagen%204-purple)](docs/)

---

## What Is Content Creator™?

Content Creator™ (CC) is an enterprise-grade SaaS platform that automates the end-to-end production of **4K, 9:16 social media advertisements**. By replacing manual agency workflows with a proprietary autonomous pipeline, CC reduces production time **from weeks to minutes** and costs by approximately **90%** — allowing any brand to scale high-frequency, high-fidelity creative at unprecedented volume.

**The core user journey is deceptively simple:**

1. A user creates a project and fills in their brand context (company, goal, offer, target audience).
2. They click **Generate Storyboard**.
3. Within minutes, 15 cinematically composed, AI-generated frames appear progressively on screen — complete with prompts, production metadata, and visual continuity.

Everything else — prompt engineering, image generation, retry logic, delivery, observability — happens autonomously in the background.

---

## Who Is This For?

### 👤 End Users (Marketers & Brand Teams)
You're a marketing team or solo operator who needs high-volume, platform-optimized ad creative *right now*. You don't want to brief an agency, wait two weeks, and spend $10,000. CC gives your brand team the creative firepower of a full production studio — directly in your browser.

### 🛠️ Developers & Contributors
You're an engineer interested in AI-native SaaS architecture, n8n pipeline design, Wix Velo backend patterns, or LLM prompt orchestration at scale. This repo is a production-grade reference implementation with full governance documentation, acceptance criteria, and versioned contracts for every module.

### 🏢 Entrepreneurs & White-Label Partners
You're building a vertical SaaS, an agency tooling platform, or an AI creative product. CC is architected for white-labeling from day one — modular, API-first, and fully documented. Swap your brand, configure your AI engine credentials, and you have a production-ready creative automation platform.

---

## Key Features

| Feature | Description |
|---|---|
| **Autonomous Storyboard Pipeline** | One click generates 15 structured storyboard frames — prompts, rendered images, and metadata — with zero manual intervention. |
| **4K, 9:16 Native Output** | All assets are generated at enterprise resolution in the vertical format native to TikTok, Reels, and Shorts. |
| **AI Engine Abstraction** | The pipeline is vendor-agnostic. Google Imagen 4 ships as the default; swap to any compatible engine without touching upstream logic. |
| **Progressive Frame Delivery** | Frames appear in the UI as each one completes — users see results immediately, not after a long blocking wait. |
| **HMAC-Secured Callbacks** | Every frame callback from n8n to the Wix backend is signed and verified. No unauthorized writes are possible. |
| **Resilient by Default** | Exponential backoff, per-frame retry logic (up to 3 attempts), graceful degradation, and failure callbacks ensure the pipeline never silently breaks. |
| **Full Audit Trail** | Every execution is logged with request IDs, component version tags, attempt counts, and stage transitions. |
| **Secrets Vault Integration** | Zero hardcoded credentials. All keys live in Wix Secrets Manager and n8n credential vaults. |

---

## Architecture Overview

Content Creator™ is a **Wix/Velo SaaS application** orchestrated through an **n8n automation pipeline** against **Google Vertex AI (Imagen 4)**. The architecture follows a fire-and-forget async dispatch model.

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (Wix Velo — /page_code)                                  │
│  Project Detail Page → validate → generateStoryboard() dispatch     │
│  Polling UI: pollStoryboardFrames() → progressive frame reveal      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HMAC-signed webhook
┌───────────────────────────▼─────────────────────────────────────────┐
│  BACKEND  (Wix Velo — /backend/services)                            │
│  generateStoryboard()  — auth · sign · dispatch to n8n              │
│  receiveFrames()       — verify HMAC · write · broadcast            │
│  getStoryboardFrames() — owner-scoped read                          │
└───────────────────────────┬──────────────────────┬──────────────────┘
                            │                      ▲
                  Webhook trigger           Per-frame callback
                            │                      │
┌───────────────────────────▼──────────────────────┴──────────────────┐
│  N8N PIPELINE  [ N8N PIPELINE : v1.0.0 ]                            │
│                                                                     │
│  Stage 1 → Webhook Trigger    (HMAC validation, payload extract)    │
│  Stage 2 → Prompt Generation  (LLM → 15 structured prompt objects)  │
│  Stage 3 → Image Gen Loop     (Imagen 4 × 15, retry logic, 9:16)   │
│  Stage 4 → Frame Callback     (HMAC-signed delivery to Wix)        │
│  Stage 5 → Error Handling     (exponential backoff, failure flags)  │
└─────────────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│  DATA LAYER  (Wix CMS)                                              │
│  projects collection       — storyboardStatus, frameCount           │
│  storyboard_frames         — projectId · owner · frameIndex · url   │
└─────────────────────────────────────────────────────────────────────┘
```

### Repository Structure

```
contentCreator/
├── backend/
│   ├── config/               # Environment constants, collection names
│   ├── integrations/         # AI engine adapters (Imagen 4, extensible)
│   ├── services/             # Core webMethods (project, storyboard, taxonomy)
│   └── databases/            # Schema definitions and seed data
├── page_code/
│   ├── dashboard/            # project-explorer, project-detail page controllers
│   └── modals/               # Settings, category, and project modals
├── public/
│   └── utils/                # Shared validation, UI helpers, storyboard poller
├── databases/                # CMS collection seeds (categories, frames)
└── docs/
    ├── ai-governance-framework.pdf
    ├── platform-standards.pdf
    ├── saas-infrastructure-compliance-model.pdf
    ├── strategic-product-brief.pdf
    └── storyboarding-feature-mvp.pdf
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **SaaS Platform** | Wix / Velo (`.web.js` webMethods, CMS, Secrets Manager) |
| **Automation Orchestrator** | n8n (self-hosted or cloud) |
| **AI Image Engine** | Google Imagen 4 via Vertex AI Prediction API |
| **LLM (Prompt Generation)** | Configurable — Claude / GPT-4 class models |
| **Auth & Security** | HMAC-SHA256 shared secret, Wix Member auth, owner-scoped DB |
| **Observability** | Structured logs with request ID, component version, stage tagging |

---

## Getting Started

### Prerequisites

- A **Wix** site with Velo enabled
- An **n8n** instance (self-hosted or [n8n Cloud](https://n8n.io))
- A **Google Cloud** project with Vertex AI API enabled and an Imagen 4 service account
- An LLM API key (Anthropic, OpenAI, or compatible)

### 1. Configure Secrets

In **Wix Secrets Manager**, create two secrets:

| Secret Name | Value |
|---|---|
| `N8N_STORYBOARD_WEBHOOK_URL` | Your n8n webhook trigger URL |
| `N8N_CALLBACK_SECRET_KEY` | A random 32+ character string |

In your **n8n credential vault**, store:

- Google Cloud Service Account (JSON key, scoped to Vertex AI Prediction)
- `N8N_CALLBACK_SECRET_KEY` (same value as above)
- `WIX_BACKEND_CALLBACK_URL` (your `receiveFrames()` endpoint URL)
- `GCP_PROJECT_ID` and `GCP_REGION` environment variables

> ⚠️ Zero hardcoded credentials are permitted anywhere in the codebase. Deployment will be rejected if secrets are found outside vault storage.

### 2. Set Up the Data Layer

In Wix CMS, create the `storyboard_frames` collection with these fields:

| Field | Type | Purpose |
|---|---|---|
| `projectId` | Text | Reference to `projects._id` |
| `owner` | Text | Wix Member ID (enforces data isolation) |
| `frameIndex` | Number | Frame sequence 0–14 |
| `imageUrl` | Text | Wix Media URL of the rendered frame |
| `promptText` | Text | The text-to-image prompt used |
| `frameData` | Object | Composition, lighting, CTA, and production metadata |
| `status` | Text | `pending` / `complete` / `failed` |

### 3. Import the n8n Pipeline

Import `storyboard__v1_0_0.json` into your n8n instance. Update the credential references to match your vault setup.

### 4. Deploy Backend Services

Deploy the Wix Velo backend from `/backend/services/`. The three core webMethods are:

- `generateStoryboard()` — validates the project, signs the webhook payload, and dispatches to n8n
- `receiveFrames()` — verifies HMAC, checks ownership, writes frame data, and broadcasts progress
- `getStoryboardFrames()` — owner-scoped frame retrieval for frontend polling

### 5. Verify End-to-End

Create a test project, populate all required fields, and click **Generate Storyboard**. The pipeline should deliver all 15 frames progressively. Check n8n execution logs for `[ N8N PIPELINE : v1.0.0 ]` entries confirming each stage.

---

## Implementation Roadmap

The platform ships in four gated phases. Each phase has explicit entry and exit criteria — no phase begins until the previous one passes.

| Phase | Name | Key Deliverables |
|---|---|---|
| **1** | Foundation | CMS collection, Secrets Manager config, n8n webhook trigger |
| **2** | Backend Services | `generateStoryboard()`, `receiveFrames()`, `getStoryboardFrames()` webMethods |
| **3** | n8n Pipeline | Prompt generation node, image generation loop, per-frame callback node |
| **4** | Frontend Integration | Storyboard poller utility, project detail page v2, full QA |

**Product Roadmap (FY 2027)**

- **Q1** — Alpha testing with internal brand team pilot
- **Q2** — Beta launch with selected enterprise partners
- **Q3** — Full market availability and API integration suite
- **Q4** — Performance optimization with AI-driven iterative creative testing

**Future State**
- Self-healing pipeline infrastructure
- AI-driven anomaly detection and predictive scaling
- Cross-model orchestration intelligence
- Fully autonomous compliance monitoring

---

## White-Label Guide

Content Creator™ is designed for white-label deployment. The architecture enforces clean separation between platform logic and branding at every layer.

**To white-label this system:**

1. **Replace brand assets** — swap logos, color tokens, and copy in `/public/utils/` and page code.
2. **Reconfigure AI engines** — the engine abstraction layer in `/backend/integrations/` allows you to point at any Imagen-compatible API without touching pipeline logic.
3. **Update taxonomy** — the `categories.csv` seed data in `/databases/` drives the business category dropdowns. Replace with your vertical's taxonomy.
4. **Version your contracts** — increment `contractVersion` on any payload schema change and maintain backward compatibility per the versioning standards in `platform-standards.pdf`.
5. **Rebrand governance docs** — the framework documents in `/docs/` define your SLA, security posture, and compliance model. Update them to reflect your entity before enterprise sales.

**Licensing inquiries** for white-label and OEM deployments: see `LICENSE.md` or contact the maintainers directly.

---

## Governance & Compliance

This system is deployed under three governing framework documents. All components must remain in compliance:

| Document | Coverage |
|---|---|
| [AI Governance Framework v1.0](docs/ai-governance-framework.pdf) | Tier 1 system controls, LLM governance, HITL escalation, audit requirements |
| [Platform Standards v2.0](docs/platform-standards.pdf) | Architecture structure, versioning standards, reliability patterns, security controls |
| [SaaS Infrastructure Compliance Model](docs/saas-infrastructure-compliance-model.pdf) | Secrets management, observability, deployment governance, SOC2 alignment |

**Human oversight is mandatory for initial production deployment** per AI Governance Framework Section 10. Repeated pipeline failures, security anomalies, or output deviations from compliance constraints require escalation to a human operator.

---

## Contributing

Contributions are welcome. Before opening a pull request, please review the governing documents above and ensure your changes comply with:

- Component-level versioning: every module must carry a `[ COMPONENT NAME : vX.X.X ]` tag
- The error response schema: `{ ok, status, error: { type, message } }`
- Zero hardcoded credentials
- Structured log entries with `requestId`, component version, and stage name
- Backward-compatible contract changes (increment `contractVersion` on breaking payload changes)

For significant architectural changes, open an issue first to discuss alignment with the platform standards before writing code.

---

## License

See `LICENSE.md` for full terms.

---

*Content Creator™ | Platform v2.0.0 | Governed under AI Framework v1.0 | INTERNAL & PARTNER USE*