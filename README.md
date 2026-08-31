# vibench

Vibench is a local tmux workbench for agent sessions. One resident Node server
keeps the registry and transcript streams. One tmux session named `vibench`
holds every bench as a window. A normal bench has two real shell panes: Neovim
on the left and Claude Code on the right. A watch-only bench has only Neovim.

Each pane inherits:

- `VIBENCH_SESSION`: the registry ID for that bench
- `VIBENCH_SERVER`: the loopback server URL
- `VIBENCH_SERVER_JSON`: the live server-discovery file
- `VIBENCH_SERVER_TOKEN`: the launch-time server-token fallback
- `VIBENCH_TMUX_SOCKET`: the isolated tmux server namespace
- `VIBENCH_TMUX_SESSION`: the reusable tmux host name
- `NVIM_APPNAME=vibench`: the isolated Neovim profile

Starting another bench adds a window to the existing host and attaches or
switches the current tmux client to it. Closing the CLI does not stop the
server, tmux host, shells, editor, or agent.

On Windows, install [psmux](https://github.com/marlocarlo/psmux), which provides
`tmux.exe`:

```powershell
winget install marlocarlo.psmux
```

On Alpine Linux, install `procps` before using the Claude harness. Vibench
rejects PID-only session matching because it is unsafe after PID reuse.

## Use

```text
vibench                                 use the current directory and first configured harness
vibench -w D -m claude --name N         select a workspace, harness, and name
vibench -s ID                           resume a harness session
vibench -s ID --watch-only              watch a session without a harness pane
vibench --no-attach                     create or focus without attaching
vibench ls                              list registered benches
vibench reset-nvim                      install the small stock profile
vibench reset-nvim --lazy               install the bundled LazyVim profile
vibench reset-nvim --clone              copy your current profile, then add Vibench
vibench kill-server                     stop the resident registry server
```

The launcher never prompts. `-w`/`--workspace` defaults to the current
directory, `-m`/`--model-harness` defaults to the first configured harness,
and `--name` defaults to the workspace basename. A new bench gets a numeric
suffix when its name is already in use. A matching workspace, harness session,
and launch mode focuses the existing bench instead.

The managed profile lives at `~/.vibench/nvim`. Vibench refreshes only its own
`plugin/vibench*.lua` and `lua/vibench` files, including in a cloned profile.
Your normal `nvim` profile and data directory remain separate.

See [Default bindings](KEYBINDINGS.md) for every global, contextual,
buffer-local, mouse, and `<Plug>` mapping installed by Vibench.
See [Product specification](SPEC.md) for settled behavior, including features
that are not implemented yet.

## Claude session tracking

Claude Code publishes live process records in `~/.claude/sessions/<pid>.json`.
Vibench accepts a record only when all of these agree:

- the record PID equals its filename;
- that PID is a live descendant of this bench's harness pane;
- the process start token matches, preventing PID-reuse mistakes;
- exactly one record matches.

The server reads only complete JSONL records from the corresponding transcript.
It retains a byte cursor, detects truncation or source replacement, and pushes
completed action snapshots to Neovim over a source-revisioned SSE stream. A
Claude `/clear`, resume, or in-process session change therefore resets the
virtual terminal instead of mixing two sessions.

Claude is the only transcript provider currently shipped. Custom harnesses can
still be launched from `~/.vibench/config.json`, but their virtual terminal
remains empty until a provider exists.

## Neovim agent terminal

`:VibenchAgentTerm` toggles the read-only terminal drawer. It renders the
command output Claude already wrote; it does not control Claude's real pane.

The global scrubber opens automatically as a fixed one-row split at the bottom
of the editor. `:VibenchScrubber` hides or restores it. Its buttons jump to the
first change, move one change backward or forward, play/pause, and return to
live. The track is clickable; its position and trailing `LIVE` toggle reflect
the shared playhead used by every Vibench panel.

Timed playback advances every 750ms by default. Set
`vim.g.vibench_playhead_interval_ms` to change that cadence.

The drawer opens live and follows new terminal actions by default. Its winbar
buttons, the scrubber controls and track, and rendered command lines are clickable.
Mouse-wheel scrolling leaves live follow; scrolling back to the bottom resumes
it. Seeking rebuilds the virtual terminal through that command, including ANSI
cursor movement and clears.

## Neovim Agent View

The listed, read-only `agent view` buffer opens in the main editing area and
follows the shared playhead. Opening another buffer replaces it normally;
`:VibenchAgentView` brings it back, and `q` or `:bdelete` closes it.

Reads show the response captured by that tool call, never the current disk
file. A patch shows the reconstructed file with a light changed-region
highlight only when Vibench can apply or reverse it exactly. Otherwise it shows
the captured patch as a raw diff.

## Neovim Tool Calls

The read-only Tool Calls pane opens in the full-height left sidebar. It yields
that column to the bundled Explorer while Explorer is open, then returns when
Explorer closes. Bottom drawers remain beside the sidebar instead of below it.
`:VibenchTools` or `<Plug>(VibenchToolsToggle)` toggles it.

Tool steps through the shared playhead are shown. Category icons and
theme-linked accents distinguish terminal, file, and Tool Info rows;
pending rows are dim and failures are red. Move through the list with
normal Neovim motions (including `Home`/`End`), then press `Enter`, or click a
row, to jump every Vibench view to that step. Playback controls remain in
the global scrubber and Agent Terminal, not in this list.

## Neovim Tool Info

`:VibenchToolInfo` opens the read-only Tool Info drawer. It shares the bottom
slot with Agent Terminal and LazyVim's terminal, so opening any one replaces
the visible drawer instead of stacking another split.

The drawer shows the latest Tool Info step at or before the shared playhead,
including its captured parameters, in-flight state, and result or error. File,
terminal, and chat steps do not appear. Its winbar controls jump to the first,
previous, next, or last Tool Info step. The configured Vibench playhead keys
work contextually in the drawer, `Left`/`Right` step between entries, and the
`<Plug>(VibenchToolInfo...)` actions are bindable. `q` hides it.

## Tests

`npm test` is tmux-free and tests Claude record selection and transcript
ordering. `npm run test:nvim` is also tmux-free and checks the frontend in a
clean, headless Neovim.

`npm run test:tmux` is deliberately opt-in. It creates real isolated tmux
servers and real Neovim processes. Do not run it in an agent session unless a
human explicitly requests that integration pass.

## MCP

Vibench writes its MCP manifest to `~/.vibench/mcp.json` and supplies it to
every Claude harness with `--mcp-config`. This launch-only config augments the
user's existing MCP sources; Vibench does not use `--strict-mcp-config` or
modify Claude's user or project configuration.

The MCP process inherits `VIBENCH_SESSION` and server discovery from its bench.
Its `workspace_state` tool reports the current Neovim focus, cursor and visible
line range, open files, windows, Vibench panels, shared playhead, and latest
visual selection. Selection text is capped at 2,000 characters and remains in
the snapshot after Visual mode ends with `active: false`.

Neovim pushes a debounced snapshot plus a five-second heartbeat. The resident
server's private discovery token protects every API route, including transcript
streams and workspace state. The server keeps only
the latest snapshot in memory and marks it stale if updates stop; editor state
is never added to the persisted session registry.
