---
title: Shell completion and agent skill
description: Turn on tab completion for sandbar in zsh, bash or fish, and teach coding agents to use it.
---

## Shell completion

Add one line to your shell's startup file:

```sh
source <(sandbar completion zsh)     # ~/.zshrc
source <(sandbar completion bash)    # ~/.bashrc
```

For fish, save the script once:

```sh
sandbar completion fish > ~/.config/fish/completions/sandbar.fish
```

Tab then completes commands, flags, `--provider` ids, `--profile` names from `sandbar.json`, and sandbox names:

```sh
sandbar exec <tab>          # web  job-1
sandbar cp ./app.py <tab>   # web:  job-1:
```

Sandbox names come from the CLI's own list, so pressing tab never calls a provider.

## Agent skill

The CLI carries an agent skill that teaches coding agents how to use it: check the setup first, always use `--json`, prefer `run` for one-off work, read exit codes, never retry an unknown outcome, and clean up. The skill always matches the installed CLI version.

```sh
sandbar skill install            # for you, in every project
sandbar skill install --project  # for this repository only
```

`install` writes the skill to `.agents/skills/sandbar-cli/`, read by most agents, and to `.claude/skills/sandbar-cli/` when Claude Code is set up. Run it again after upgrading the CLI to update the skill. It never replaces a copy you installed another way.

`sandbar skill` prints the skill, for agents without a skill system: paste it into their instructions.

The skill can also be installed with `npx skills add pandemicsyn/sandbar --skill sandbar-cli`. See [Agent skills](/docs/agents/skills/) for the SDK skill as well.
