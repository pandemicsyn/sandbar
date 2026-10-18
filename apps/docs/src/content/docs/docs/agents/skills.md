---
title: Agent skills
description: Install Sandbar skills so coding agents know how to build with the SDK and drive sandboxes from the shell.
---

Sandbar ships two agent skills in the [`skills/`](https://github.com/pandemicsyn/sandbar/tree/main/skills) folder of its repository. A skill is a `SKILL.md` file that an agent loads when a task needs it, so the guidance stays out of your prompt until it is useful.

| Skill         | Teaches an agent to                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbar`     | Write application code with `sandbar-sdk` and a provider adapter: connect, create and clean up sandboxes, run commands, move files, and handle uncertain outcomes without repeating work. |
| `sandbar-cli` | Create, use and remove sandboxes from the shell with the `sandbar` command, read its JSON output and exit codes, and clean up after failures.                                             |

## Install

Install with the [`skills`](https://github.com/vercel-labs/skills) installer, which supports Claude Code, Codex, Cursor and other agents:

```sh
npx skills add pandemicsyn/sandbar --skill sandbar -g
npx skills add pandemicsyn/sandbar --skill sandbar-cli -g
```

`-g` installs the skill for your user. Leave it out to install into the current project instead, so everyone working in the repository gets it.

For an agent without a skill system, copy the `SKILL.md` contents into its project or user instructions.

## What the skills do not do

The skills never hold credentials. The SDK skill reads keys from environment variables; the CLI skill uses your existing `sandbar.json` profiles and tells the agent to leave configuration to you. Both tell the agent that live sandboxes cost money, to clean up what it creates, and never to retry an operation whose outcome is unknown.

For one-off tasks you can still paste the [SDK prompt](/docs/agents/build-with-sdk/) or the [provider integration prompt](/docs/agents/build-a-provider/) instead.
