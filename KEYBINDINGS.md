# Default bindings

This file lists every mapping installed by Vibench. It does not include
Neovim, LazyVim, tmux, or mappings from a copied user profile. Vibench does not
add tmux bindings.

Update this file in the same commit as any default mapping change.

## Shared playhead

The shared playhead controls the timeline used by every Vibench view.
"Contextual" means a buffer-local mapping in Agent Terminal, Agent View, the
scrubber, Tool Info, and DATA. Contextual mappings work in Normal and
Terminal modes and take precedence over an occupied global mapping inside
those buffers. An existing buffer-local mapping keeps precedence.

| Default key | Normal action | Tool Info drawer action | Scope | Shared `<Plug>` action |
| --- | --- | --- | --- | --- |
| `Ctrl-h` | Previous timeline step | Previous Tool Info step | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadPrev)` |
| `Backspace` | Previous timeline step | Previous Tool Info step | Contextual only; alias for the default `Ctrl-h` | `<Plug>(VibenchPlayheadPrev)` |
| `Space` | Play or pause | Play or pause | Contextual only | `<Plug>(VibenchPlayheadPlayPause)` |
| `Ctrl-l` | Next timeline step | Next Tool Info step | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadNext)` |
| `Ctrl-Shift-h` | First timeline step | First Tool Info step | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadHome)` |
| `Ctrl-Shift-l` | Final current timeline step; stay there | Last Tool Info step | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadEnd)` |
| `<leader>P` | Toggle live follow | Toggle live follow | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadLive)` |
| `<leader>W` | Toggle Watch | Toggle Watch | Global Normal mode if free, plus contextual | `<Plug>(VibenchPlayheadWatch)` |

Some terminals cannot distinguish a Ctrl letter from its Ctrl-Shift form.
Rebind the corresponding `<Plug>` action when that happens.

The Tool Info drawer overrides only the physical contextual keys in this
table. Calling a shared playhead `<Plug>` action directly still operates on the
full timeline. Use the Tool Info `<Plug>` actions below for filtered
navigation.

## Panel activation

Each default binding is installed independently in Normal mode and only when
the key is free.

| Panel | Default keys | Command | `<Plug>` action |
| --- | --- | --- | --- |
| Agent Terminal | `Alt-Shift-a` (`<M-A>`), `<leader>z` | `:VibenchAgentTerm` | `<Plug>(VibenchAgentTermToggle)` |
| Tool Info drawer | `Alt-Shift-i` (`<M-I>`), `<leader>i` | `:VibenchToolInfo` | `<Plug>(VibenchToolInfoToggle)` |
| Tool Calls sidebar | `<leader>t` | `:VibenchTools` | `<Plug>(VibenchToolsToggle)` |
| Agents sidebar | `<leader>A` | `:VibenchAgents` | `<Plug>(VibenchAgentsToggle)` |
| Scrubber | None | `:VibenchScrubber` | None |
| Agent View | `<leader>a` | `:VibenchAgentView` opens or restores it | `<Plug>(VibenchAgentViewOpen)` |
| Chat | `<leader>C` | `:VibenchChat` | `<Plug>(VibenchChatToggle)` |
| DATA drawer | `<leader>D` | `:VibenchData` | `<Plug>(VibenchDataToggle)` |

## Buffer-local bindings

### Agent Terminal

| Key | Action |
| --- | --- |
| Shared playhead keys | Navigate or play the full timeline |
| `i`, `I`, `a`, `A`, `o`, `O`, `c`, `C`, `s`, `S`, `r`, `R` | Ignored to keep the terminal read-only |
| `PageUp`, `PageDown`, `Ctrl-u`, `Ctrl-d`, `Ctrl-b`, `Ctrl-f`, `Ctrl-y`, `Ctrl-e` | Keep their native scrolling behavior and update live follow based on whether the view is at the bottom |
| Left mouse click on a command | Jump the shared playhead to that command |
| Mouse wheel | Scroll and update live follow |

The Agent Terminal winbar buttons jump to the first, previous, next, or final
timeline position.

### Agent View

| Key | Action |
| --- | --- |
| Shared playhead keys | Navigate or play the full timeline |
| `gf` | Open the shown live file as an editable buffer at the relevant line |
| `q` | Close Agent View and disable automatic reopening |

### Scrubber

| Key | Action |
| --- | --- |
| Shared playhead keys | Navigate or play the full timeline |
| `Left` | Previous timeline step |
| `Right` | Next timeline step |
| `Home` | First timeline step |
| `End` | Final current timeline step; stay there |
| `q` | Hide the scrubber |

The first, previous, play or pause, next, final, `WATCH`, track, and `LIVE`
controls are clickable.

### Tool Calls sidebar

| Key | Action |
| --- | --- |
| `Enter` | Jump the shared playhead to the selected call |
| Native vertical motions, including `j`, `k`, `gg`, and `G` | Select the call under the cursor and move the shared playhead |
| `Home` | Select the first call and move the shared playhead |
| `End` | Select the last call and move the shared playhead |
| `q` | Hide the sidebar |
| Left mouse click on a row | Jump the shared playhead to that call |

Normal Neovim motions remain native; arriving on another row selects that
call. The sidebar does not install contextual playhead mappings, though any
free global playhead defaults still apply in Normal mode.

### Agents sidebar

| Key | Action |
| --- | --- |
| `Enter` | Select the root or child agent |
| `q` | Hide the sidebar |
| Left mouse click on a row | Select the root or child agent |

Normal Neovim motions such as `j` and `k` remain unchanged.

### Tool Info drawer

| Key | Action | Bindable action |
| --- | --- | --- |
| `Ctrl-h`, `Backspace` | Previous Tool Info step | `<Plug>(VibenchToolInfoPrev)` |
| `Space` | Play or pause the full timeline | `<Plug>(VibenchPlayheadPlayPause)` |
| `Ctrl-l` | Next Tool Info step | `<Plug>(VibenchToolInfoNext)` |
| `Ctrl-Shift-h` | First Tool Info step | `<Plug>(VibenchToolInfoHome)` |
| `Ctrl-Shift-l` | Last Tool Info step | `<Plug>(VibenchToolInfoEnd)` |
| `Left` | Previous Tool Info step | `<Plug>(VibenchToolInfoPrev)` |
| `Right` | Next Tool Info step | `<Plug>(VibenchToolInfoNext)` |
| `q` | Hide the drawer | `<Plug>(VibenchToolInfoHide)` |

The drawer winbar buttons jump to the first, previous, next, or last Tool Info
step.

### Chat

| Key | Action |
| --- | --- |
| `q` | Close Chat |

Chat keeps native Normal-mode movement, scrolling, search, and selection. It
has no buffer-local playback controls.

### DATA

| Key | Action |
| --- | --- |
| Shared playhead keys | Navigate or play the full timeline |
| `q` | Hide the drawer |

DATA keeps native Normal-mode movement, scrolling, search, and selection.

## Additional `<Plug>` actions

| Action | `<Plug>` mapping |
| --- | --- |
| Select the Agent Terminal command under the cursor | `<Plug>(VibenchAgentTermSelect)` |
| Open Agent View | `<Plug>(VibenchAgentViewOpen)` |
| Open the live file shown by Agent View | `<Plug>(VibenchAgentViewOpenFile)` |
| Close Agent View | `<Plug>(VibenchAgentViewClose)` |
| Hide the scrubber | `<Plug>(VibenchScrubberHide)` |
| Toggle Tool Calls sidebar | `<Plug>(VibenchToolsToggle)` |
| Select the Tool Calls row under the cursor | `<Plug>(VibenchToolsSelect)` |
| Select the first visible Tool Calls row | `<Plug>(VibenchToolsHome)` |
| Select the last visible Tool Calls row | `<Plug>(VibenchToolsEnd)` |
| Hide Tool Calls sidebar | `<Plug>(VibenchToolsHide)` |
| Toggle Agents sidebar | `<Plug>(VibenchAgentsToggle)` |
| Select the Agents row under the cursor | `<Plug>(VibenchAgentsSelect)` |
| Hide Agents sidebar | `<Plug>(VibenchAgentsHide)` |
| Toggle Tool Info drawer | `<Plug>(VibenchToolInfoToggle)` |
| Hide Tool Info drawer | `<Plug>(VibenchToolInfoHide)` |
| Toggle Chat | `<Plug>(VibenchChatToggle)` |
| Close Chat | `<Plug>(VibenchChatClose)` |
| Toggle DATA drawer | `<Plug>(VibenchDataToggle)` |
| Hide DATA drawer | `<Plug>(VibenchDataHide)` |
| First Tool Info step | `<Plug>(VibenchToolInfoHome)` |
| Previous Tool Info step | `<Plug>(VibenchToolInfoPrev)` |
| Next Tool Info step | `<Plug>(VibenchToolInfoNext)` |
| Last Tool Info step | `<Plug>(VibenchToolInfoEnd)` |

The shared playhead and Agent Terminal `<Plug>` mappings in the earlier tables
are also always available, even when physical defaults are disabled or skipped
because of a collision.
Keyboard and mouse selection routes use the same panel selection action.

## Configuration

Set these variables before Vibench plugins load.

Disable every physical shared-playhead default while retaining its `<Plug>`
actions:

```lua
vim.g.vibench_playhead_default_keymaps = false
```

Replace or disable individual playhead keys:

```lua
vim.g.vibench_playhead_keymaps = {
  prev = '<M-h>',
  play = '<M-Space>',
  next = '<M-l>',
  home = '<M-S-h>',
  ['end'] = '<M-S-l>',
  live = '<M-P>',
  watch = '<M-W>',
}
```

Omit an entry to retain its default. Set an entry to `false` to disable that
physical binding. A custom key is always installed contextually. Vibench also
installs it globally in Normal mode when free, including a custom `play` key.
`Backspace` is added only when `prev` uses its default `Ctrl-h` key.

Change or disable the Agent Terminal toggle defaults:

```lua
vim.g.vibench_agentterm_keymaps = { toggle = '<F9>' }
-- or
vim.g.vibench_agentterm_default_keymaps = false
```

Change or disable the Tool Info drawer toggle defaults:

```lua
vim.g.vibench_toolinfo_keymaps = { toggle = { '<F10>', '<leader>i' } }
-- or
vim.g.vibench_toolinfo_default_keymaps = false
```

Both `toggle` settings accept one string or a list of strings.
`:VibenchAgentTermHealth` reports Agent Terminal and shared-playhead defaults
that Vibench skipped because a global key was already occupied.

Disable the Tool Calls sidebar, Agents sidebar, Agent View, Chat, or DATA physical default
while retaining its `<Plug>` action:

```lua
vim.g.vibench_tools_default_keymaps = false
vim.g.vibench_agents_default_keymaps = false
vim.g.vibench_agentview_default_keymaps = false
vim.g.vibench_chat_default_keymaps = false
vim.g.vibench_data_default_keymaps = false
```
