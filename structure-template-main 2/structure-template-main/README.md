# Structure Template

Reusable human-facing project documentation structure.

This repo is the canonical source of truth for the `structure/` pattern used across projects.

It defines:

- the default `structure/` folder shape
- the purpose of each layer
- the boilerplate-ready templates for those layers
- the beginner workflow for using LLMs with a project
- the conventions for keeping project docs model-agnostic and human-readable

Use this repo when you want to:

- start a new project with a clean `structure/` layer
- copy the default folders and starter docs
- align models quickly without making them read long procedural guides
- keep documentation conventions consistent across repos

## What Problem This Solves

Many repos mix several different jobs into one documentation layer:

- setup instructions
- architecture notes
- release strategy
- role alignment for humans and models
- deployment runbooks

That usually leads to overlap, drift, and long onboarding docs that do too many things at once.

This template separates those jobs into a stable human-facing structure:

- `Purpose/` for role alignment
- `User_Guide/` for procedures
- `Development/` for repo-shaping guidance
- `System Guide/` for durable architecture
- `Deployment/` for release and runbook material

## Canonical Scope

This repo is the specification, not a project implementation.

Other repos may adapt the template, but this repo should define the canonical pattern.

## Default Shape

The core template is:

- `structure/INDEX.md`
- `structure/HOW_TO_USE.md`
- `structure/Purpose/README.md`
- `structure/User_Guide/README.md`
- `structure/Development/README.md`
- `structure/System Guide/README.md`
- `structure/Deployment/README.md`

Projects can add more folders, but these are the load-bearing defaults.

Starter boilerplate is included for:

- `HOW_TO_USE.md`
- `Purpose/README.md`
- `Purpose/examples/dev-audit-loop.md`
- `User_Guide/getting-started.md`
- `Development/coding-principles.md`
- `Development/release-strategy.md`
- `Development/roadmap.md`
- `Development/purpose-template.md`
- `Development/structure-convention.md`
- `System Guide/architecture.md`
- `Deployment/deploy.md`

## Example Tree

```text
structure/
  INDEX.md
  HOW_TO_USE.md
  Purpose/
    README.md
    examples/
      dev-audit-loop.md
  User_Guide/
    README.md
    getting-started.md
  Development/
    README.md
    coding-principles.md
    release-strategy.md
    roadmap.md
    purpose-template.md
    structure-convention.md
  System Guide/
    README.md
    architecture.md
  Deployment/
    README.md
    deploy.md
```

## Core Rule

`structure/` is the human-facing layer.

It should stay useful even if:

- the active model changes
- the runtime changes
- the deployment target changes
- the implementation details shift underneath it

The point is legibility outside the live runtime.

## Design Principles

- Separate orientation from procedures.
- Keep role alignment short and explicit.
- Keep setup docs operational rather than philosophical.
- Keep architecture docs durable rather than sprint-specific.
- Keep boilerplate generic enough to copy into a new repo.

## Quick Start

1. Copy the `structure/` folder into a new repo.
2. Read `structure/HOW_TO_USE.md`.
3. Replace placeholders in `Purpose/README.md`.
4. Fill in `User_Guide/getting-started.md` with the shortest local setup path.
5. Fill in `System Guide/architecture.md` with the durable system shape.
6. Add project-specific files only after the default layers are clear.

## Where To Start

If you are adapting the template:

- start with `./structure/HOW_TO_USE.md`
- then read `./structure/Purpose/README.md`
- then read `./structure/Development/structure-convention.md`
- then customize the starter docs under `User_Guide/`, `Development/`, `System Guide/`, and `Deployment/`

If you want to understand the LLM workflow quickly, read `./structure/Purpose/examples/dev-audit-loop.md`.

## Boilerplate Rule

This template should be safe to publish and safe to copy.

Do not bake in:

- named individuals unless the project actually requires them
- company-internal assumptions
- machine-specific local paths unless they are clearly examples
- product-specific claims that do not generalize
