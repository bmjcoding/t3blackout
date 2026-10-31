// Which update channels a machine builds. With a pin.json, a channel it pins is
// built at exactly that release; a channel it doesn't pin is refused, because
// building its newest release would skip every gate the evaluator applies
// (dependency age, device tools, advisories). `--unpinned` opts back into that
// legacy behavior, as having no pin.json does: the newest release soakHours old.

/** Why `channel` can't be built from `pin` (pin.json, or null), or null when it can. */
export function unpinnedProblem(pin, channel, { unpinned = false, soakHours }) {
  if (!pin || pin.channels[channel] || unpinned) return null;
  const pinned = Object.keys(pin.channels);
  return (
    `the ${channel} channel has no evaluated release in pin.json, so T3 Blackout won't build it; ` +
    `switch the update track to ${pinned.join(" or ") || "a pinned channel"}, or pass --unpinned to build its newest release ${soakHours}h old without the evaluator's gates`
  );
}

/** What `channel` builds and which gates chose it, for `t3blackout status`. */
export function channelPolicy(pin, channel, { soakHours, minAgeDays }) {
  if (!pin) return `${channel}: no pin.json, so the newest release ${soakHours}h old, without the evaluator's gates`;
  const entry = pin.channels[channel];
  if (!entry) return `${channel}: not pinned, so updates are refused (pinned: ${Object.keys(pin.channels).join(", ") || "none"}; --unpinned builds its newest release ${soakHours}h old)`;
  return (
    `${channel}: pinned to ${entry.ref} (${entry.sha.slice(0, 10)}), evaluated ${entry.evaluatedAt}: new dependencies at least ` +
    `${minAgeDays} days old (a vetted security fix may be younger), device tools reviewed, built and smoke-tested in CI`
  );
}
