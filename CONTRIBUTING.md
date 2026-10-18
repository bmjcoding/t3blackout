# Contributing

## Spinner verbs

While an agent works, the working indicator shows a random verb that changes
every few seconds ("Percolating…", "Spelunking…"). The list lives in
[`lib/files/ClaudeSpinner.verbs.txt`](lib/files/ClaudeSpinner.verbs.txt) and
new ones are welcome.

- One verb per line: a single capitalized word ending in "ing", letters only
  (no spaces or hyphens).
- Keep the file in alphabetical order. This keeps diffs small and pull
  requests from clashing.
- Fun beats accurate, but steer clear of anything that sounds alarming
  mid-task ("Deleting…", "Deploying…") or that you wouldn't want on a
  colleague's screen.

Check your change before opening a pull request:

```sh
bin/t3blackout check
```

The check names any line that breaks the rules above.
