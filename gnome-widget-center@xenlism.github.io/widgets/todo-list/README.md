# To-Do List

`2x2` checklist widget. Add tasks, check them off, and clear completed
ones straight from the desktop - no window to open.

## Behavior

- Tap **+** in the header to add a task. Typing opens the same
  `ModalDialog` + `St.Entry` pattern `xtile` uses to prompt for a name,
  so the on-screen keyboard/focus behaves the same way across widgets.
- Tap a task's checkbox to mark it done (strikethrough text, dimmed
  color) or done → not done again.
- Tap the trash icon on a row to delete that task.
- The header's "clear" icon (only visible once at least one task is
  done) removes every completed task in one tap.
- Tasks are stored as a plain array (`todoItems`) of
  `{ id, text, done, createdAt }` written into the widget's own
  settings file as extra keys - the same "state lives outside
  `config.json`" pattern `pomodoro-timer` uses for its phase/running
  state - so the list survives a Shell restart.
- With **Move completed tasks to the bottom** on (default), unchecked
  tasks always sort above checked ones; turn it off to keep strict
  insertion order instead.
- **Max visible tasks** caps how many rows render at once (older/extra
  tasks show as a "+N more" counter rather than disappearing) so the
  card never outgrows its `2x2` footprint.

## Settings (To-Do List tab)

- **Card**: background color, corner radius.
- **Tasks**: title text, max visible tasks, auto-sort completed to
  bottom.
- **Text**: title font/color, task font/color, completed-task color,
  and the checkbox/accent color.
- **Shadow**: standard drop-shadow tab shared by all widgets.
