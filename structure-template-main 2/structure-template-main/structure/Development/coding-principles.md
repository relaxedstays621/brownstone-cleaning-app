# Coding Principles

These rules are for writing and shaping project code.

They are not optional style preferences. They are build rules.

## Core Rule

Project code should favor:

- centralization of authority
- modularization of execution
- abstraction for simplicity
- orthogonality for independence

These four principles are meant to coexist.

Centralize what defines the system.

Modularize what carries the system out.

Abstract what should stay simple at the interface.

Keep independent concerns orthogonal so change stays local.

## Centralize

Keep one clear authority point for:

- environment and config access
- schemas and durable data shape
- integration boundaries to external services
- routing rules and system policy
- state definitions that other modules depend on

Do not duplicate load-bearing logic across scripts, modules, or interfaces.

If multiple parts of the system need the same rule, move that rule to one explicit source of truth.

## Human-Facing And Machine-Enforced

When a rule is useful to a human and mechanically enforceable, prefer both.

The human-facing layer should explain the rule in plain language.

The machine-facing layer should check the rule automatically when the enforcement cost is reasonable.

Examples:

- a task can be readable in a task-state file and still carry `owner`, `next-review`, and `criterion`
- a module contract can document a test and the test can be run by the project's test runner
- a commit message rule can live in the coding standard and also be checked by a project-specific commit checker

Do not leave load-bearing rules as decorative policy when a small script can enforce them.

Do not over-enforce rules whose judgment cost is higher than the drift they prevent.

## Modularize

Break execution into bounded parts for:

- modules
- adapters
- API handlers
- UI components
- maintenance routines

Modules should be easy to replace, audit, and test without rewriting the whole system.

Modularity does not mean scattering authority. It means keeping execution surfaces narrow and composable.

## Abstract

Hide implementation complexity behind stable, legible interfaces.

The visible surface of the system should be simpler than the machinery behind it.

Use abstraction to reduce cognitive load, not to create mystery.

Good abstraction means:

- a small number of clear commands or entry points
- shared utilities instead of repeated low-level logic
- stable interfaces around backends, paths, runtime state, and control-plane actions
- implementation detail staying inside the owning module

Bad abstraction means:

- vague wrappers that hide where authority actually lives
- helper layers that duplicate underlying rules
- naming that sounds generic but does not reduce real complexity

## Orthogonalize

Keep distinct concerns independent so one change does not force unrelated changes elsewhere.

Orthogonality protects the system from entanglement.

Good orthogonality means:

- runtime use and meta-development stay separate
- policy and execution do not collapse into one file
- feature activation, backend dispatch, path resolution, and audit logic have distinct boundaries
- changing one backend or one feature does not require rewriting unrelated system pieces

Bad orthogonality means:

- one module carrying multiple unrelated responsibilities
- path, policy, state, and execution logic fused together
- side effects that leak across the system without a clear boundary
- a refactor in one subsystem forcing incidental edits in many others

## Anti-Patterns

Avoid:

- duplicated business logic in multiple files
- hidden config access spread across the repo
- one-off scripts that silently redefine canonical rules
- feature work that bypasses shared system boundaries
- modules that own both policy and every downstream implementation detail
- abstractions that make the surface more confusing instead of simpler
- subsystem coupling that makes independent changes impossible

## Commit Discipline

Every commit should be a small, self-contained change with a project-appropriate subsystem prefix.

The allowed prefixes are project-specific. Keep them in a local override file when this scaffold is reused across projects.

Use the subsystem that owns the behavior being changed. Documentation-only changes use `[docs]` unless the documentation is part of a subsystem contract, in which case use that subsystem.

Non-functional changes must be marked as NFC:

```text
[runtime] NFC — extract preflight helper
```

Do not mix NFC refactors with behavior changes. If a cleanup enables a functional fix, split it into separate commits.

Examples:

```text
[runtime] fix audit evidence labels
[state] ignore generated runtime manifests
[docs] document commit discipline
```

If the project has a commit-message checker, use that checker as the machine-enforced version of this rule.

Malformed commits:

- missing subsystem prefix
- using NFC for a behavior change
- mixing unrelated subsystems in one commit
- bundling generated runtime files with source changes

## Practical Test

Before merging new code, ask:

1. Where is the single source of truth?
2. What module boundary owns execution?
3. Did this abstraction make the interface simpler?
4. Did this change preserve orthogonality between concerns?
5. Did this change create a duplicate rule?
6. If this integration changes, is there one place to update it?
7. Is the commit message prefixed with the owning subsystem?
8. If this is NFC, is it free of behavior changes?

If those answers are unclear, the code is not shaped correctly yet.
