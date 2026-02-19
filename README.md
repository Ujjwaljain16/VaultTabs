
# VaultTabs

**Zero-Knowledge • Cross-Browser • Workspace Sync**

> Your tabs are your workflow.
> VaultTabs makes them portable — without ever reading them.

---

## WORK IN PROGRESS

This project is actively under development.

Core encryption infrastructure is implemented.
Phase 1 (event-driven snapshot sync) is currently being wired into the extension service worker.

Expect breaking changes until v0.1.0.

---

# What is VaultTabs?

VaultTabs is a privacy-first, end-to-end encrypted tab synchronization system that works across browsers and devices.

It captures your open tab state on desktop, encrypts it locally, uploads only ciphertext to the cloud, and lets you securely view and restore those tabs from any device — including mobile browsers that do not support extensions.

Unlike native browser sync:

* It is cross-browser.
* It is zero-knowledge.
* It does not lock you into a vendor ecosystem.
* The server cannot read your tabs.

---

# Why This Exists

Modern tab sync solutions:

* Are browser-locked (Chrome ↔ Chrome, Safari ↔ Safari).
* Are inconsistent across platforms.
* Do not provide structured, searchable external access.
* Do not guarantee zero-knowledge privacy.

VaultTabs solves this by acting as an independent encrypted workspace memory layer above the browser.

---

# Core Principles

1. Zero-Knowledge Architecture
   The server stores encrypted blobs only.

2. Client-Side Encryption
   All tab metadata is encrypted before leaving your device.

3. Cross-Browser Compatibility
   Works across Chromium browsers and Firefox.

4. Snapshot-Based Reliability
   Designed for consistent recovery and restoration.

5. No Vendor Lock-In
   Backend can be self-hosted in the future.

---

# Features (Phase 1)

* Event-driven tab snapshot capture
* Debounced sync batching
* AES-256-GCM encryption via WebCrypto
* Secure master key generation
* Encrypted blob upload
* Multi-device support
* Mobile PWA access
* Session restoration
* Crash recovery

---

# Architecture Overview

VaultTabs consists of three components:

1. Desktop Browser Extension
2. Backend API + Encrypted Blob Storage
3. Web App / PWA (for mobile + cross-device access)

High-Level Flow:

Desktop Extension
→ Capture Tabs
→ Encrypt Snapshot
→ Upload Encrypted Blob
→ PWA Downloads
→ Client-Side Decrypt
→ Render Tabs

The backend never sees plaintext URLs.

---

# Tech Stack

## Extension

* WXT
* TypeScript
* Manifest V3
* WebCrypto API
* IndexedDB
* chrome.tabs API
* chrome.alarms API

## Backend

* Node.js
* Fastify
* PostgreSQL
* Cloudflare R2 (encrypted blob storage)
* JWT Authentication

## Web App (PWA)

* Next.js
* TypeScript
* TailwindCSS
* WebCrypto
* IndexedDB

Deployment targets:

* Fly.io / Railway (API)
* Vercel (Web App)
* Cloudflare (Storage + CDN)

---

# Encryption Model

VaultTabs uses a master-key architecture.

1. A random 256-bit master key is generated on the client.
2. The master key is encrypted using a password-derived key.
3. Only the encrypted master key is stored server-side.
4. Snapshots are encrypted using AES-256-GCM.
5. Decryption happens only on user devices.

The server cannot decrypt:

* URLs
* Titles
* Tab metadata
* Session structure

This is a zero-knowledge system.

---

# Sync Model

VaultTabs does NOT poll every 15 seconds.

Instead, it uses:

* Event-driven triggers (tab created, removed, updated)
* 3-second debounce batching
* Periodic fallback alarm (every few minutes)
* Snapshot hashing to avoid redundant uploads

This ensures:

* Low CPU usage
* Low bandwidth consumption
* Efficient battery behavior
* Near real-time feel

---

# Supported Browsers

Desktop:

* Google Chrome
* Brave
* Microsoft Edge
* Opera
* Vivaldi
* Firefox (separate build)

Mobile:

* Any mobile browser via PWA
* No extension required

---

# Repository Structure (Planned)

```
/extension
  /background
  /popup
  /utils

/backend
  /src
    /routes
    /services
    /auth

/web
  /app
  /components
  /crypto
```

---

# Roadmap

## Phase 1

Core snapshot sync
Encryption pipeline
Backend upload
Mobile decryption dashboard

## Phase 2

Encrypted snapshot history
Session timeline view
Self-hosting option

## Phase 3

Peer-to-peer local sync
Advanced diff-based syncing
Workspace tagging

---

# Security Disclaimer

If you forget your password, your encrypted data cannot be recovered.

This is intentional.

VaultTabs prioritizes privacy over convenience.

---

# Current Status

* Crypto layer implemented
* Backend snapshot endpoint ready
* Background service worker shell written
* Event-driven sync logic being integrated

Next milestone:
Stable encrypted snapshot upload from extension.

---

# Contributing

This project is currently private and experimental.

Public contribution guidelines will be added after initial stabilization.

---

# Philosophy

VaultTabs treats browser tabs as:

A live, evolving workspace state.

Not bookmarks.
Not history.
Not temporary noise.

Your tabs reflect what you are thinking about right now.

They deserve portability — without surveillance.

---
