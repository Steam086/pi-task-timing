# pi-task-timing

A [Pi](https://github.com/earendil-works/pi-mono) extension that records task and tool execution timing and makes the session tree easier to inspect.

## Features

- Shows a live elapsed-time counter while Pi is working, measured from the latest user input.
- Adds a persistent summary after each settled assistant response, measured from the latest user input and including the tool count for that interval.
- Records precise start time, end time, duration, and success/error state for tool executions.
- Adds `/tool-times`, an overlay showing the current branch's tool execution timeline.
- Enhances `/tree` with timestamps, tool durations, compact tool-call summaries, and warnings for large tool results.
- Adds actions to tree entries for viewing tool details, jumping to the corresponding transcript entry, or continuing from that point.

Timing data is stored in the local Pi session. The extension makes no network requests.

## Install

Install directly from GitHub as a Pi package:

```bash
pi install git:github.com/Steam086/pi-task-timing@v0.1.0
```

SSH works as well:

```bash
pi install git:git@github.com:Steam086/pi-task-timing.git
```

Restart Pi after installation, or use `/reload` in an existing session.

To try the package for one run without adding it to your settings:

```bash
pi -e git:github.com/Steam086/pi-task-timing
```

## Usage

The elapsed-time indicator and task summaries work automatically.

Open the tool timing timeline with:

```text
/tool-times
```

Open `/tree` to inspect timestamps and durations. Selecting a user message, assistant message, or tool result opens an action menu. Tool results also provide a detailed view of arguments, output, metadata, and timing.

## Compatibility

Tested with Pi `0.84.3`.

The enhanced `/tree` and transcript-jump behavior integrates with Pi's internal TUI components. Those features may need updates when Pi changes its internal component structure. Non-TUI modes still record task and tool timing, but interactive overlays and tree enhancements require the fullscreen TUI.

## Development

```bash
npm install
npm run typecheck
npm run check
```

The package manifest follows Pi's package format and loads `extensions/task-timing.ts` through `pi.extensions`.

## Security and privacy

Pi extensions run with the user's full system permissions. Review extension source before installing any third-party package.

This extension does not execute shell commands, read project files, or send data over the network. It processes session messages already available to Pi and persists timing metadata in the local session.

## License

[MIT](LICENSE)
