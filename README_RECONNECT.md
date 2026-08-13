# Reconnect-safe update

Temporary browser/mobile Socket.IO disconnects no longer immediately remove a player.

- Player seats are reserved for 5 minutes by default.
- Set `RECONNECT_GRACE_MS` on Render to change the grace window (milliseconds).
- Switching apps/tabs, locking a phone, or changing network can reconnect to the same PID.
- A deliberate Leave still removes the player immediately.
- The host remains host while temporarily disconnected; after the grace window expires, host ownership can move on.
- The browser always tries to restore `imposter.seat`, even after the page was reloaded while backgrounded.
- Socket.IO retries forever and reconnects immediately when the tab becomes visible / network comes online.

Important: rooms still live in Node process memory. A Render process restart, redeploy, or free-service spin-down can erase all rooms. For rooms that must survive those events, move room state into a persistent store such as Redis/Render Key Value or Postgres.
