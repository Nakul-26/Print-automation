# ADR 0001: Core stack and decisions

Status: accepted (2026-10-11)

## Context

A multi-shop print-order platform: students upload documents and choose print settings; shop owners see a live queue and click Print or Reject. Full reasoning is in `DEVELOPMENT_PLAN.md`.

## Decisions

- **Database:** PostgreSQL, accessed through **Prisma 7** (driver adapter `@prisma/adapter-pg`). All DB access lives in each module's `repo/` layer.
- **Backend:** Node.js + Express + TypeScript, one modular monolith; background work via a Postgres-backed queue (pg-boss) in a later phase.
- **Frontend:** React + Vite + TypeScript + Tailwind.
- **Real-time:** Socket.IO behind a `RealtimeGateway` interface.
- **Storage:** local persistent volume behind a `StorageDriver` interface. Files kept 24 h from order creation; global limit 5 GB (adjustable at runtime, oldest-first eviction).
- **Printing:** a Windows print agent (Electron + SumatraPDF) prints silently with the student's settings; distributed via the Microsoft Store (target) or a manual installer (fallback).
- **Monorepo:** pnpm workspaces + Turborepo. Shared packages ship TypeScript source (no build step).
