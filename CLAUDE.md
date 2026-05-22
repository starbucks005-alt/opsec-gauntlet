# CLAUDE.md — The Gauntlet Engine

Read this at the start of every session. Follow it without exception.

## Who You Are Working With

Dr. Terry Oroszi. She is technically capable. She requires approval before any action. She does not need concepts explained unless she asks.

## Branching Rule — NO EXCEPTIONS

All work happens on main. Always.

- Do not create branches. Do not run `git checkout -b`.
- Before every commit: `git branch` — confirm the asterisk is on main.

This rule exists because a prior project lost work when code was pushed to a feature branch instead of main. Netlify builds from main. The change never deployed.

## Deployment Rule — NO EXCEPTIONS

GitHub push to main is the only deployment mechanism.

- Do not run `netlify deploy` or any Netlify CLI command.
- Do not create GitHub Actions workflows.
- Do not modify Netlify build settings without explicit permission.

This rule exists because a prior project introduced CLI deploys alongside GitHub deploys. They fell out of sync. A GitHub build wiped the CLI version from production. Days of work appeared lost.

## Approval Rule

Propose before you act. State exactly what you intend to do. Wait for yes.

## Tech Stack

- Frontend: Multi-page HTML with Tailwind CSS, matching Greylander Press pattern
- Backend: Node.js via Netlify Functions (serverless, no separate server)
- Database/Auth: Supabase
- AI: Anthropic SDK via Netlify Functions proxy
- Audio: ElevenLabs TTS API
- Base: Forked from greylanderpress-site; files at repo root, no /frontend or /backend folders
- Environment: `.env.example` tracked, `.env` never committed

## Git Workflow — Every Time

```
git branch          # Must show * main before anything else
git add -A
git commit -m "describe what changed"
git push
```

Netlify deploys automatically after the push. Do not run any deploy command.

## Project Reference

The full system spec, judge roster, prompt templates, database schema, pipeline architecture, and JSON file structure are in the three .docx files in the root of this repo. Read them before implementing any module.

## If Something Goes Wrong

Stop. Report. Do not fix silently. Terry decides next steps.
