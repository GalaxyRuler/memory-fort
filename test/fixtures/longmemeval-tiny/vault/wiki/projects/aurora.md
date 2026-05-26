---
title: Aurora Project State Store
type: project
status: active
tags:
  - aurora
  - sqlite
updated: 2026-05-01
---

The Aurora project chose SQLite for local task state. The decision keeps queue metadata, checkpoint cursors, and local task state in a single file.
