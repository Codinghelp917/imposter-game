# Imposter

An Among Us–style online party word game. Everyone gets the same secret word
except the imposter, who only gets a vague hint. Players take turns dropping one
clue each on a 30-second timer, then the crew votes someone out.

Node + Express + Socket.IO. Rooms live in the Node process's memory.

```bash
npm install
npm start
```

Then open `http://localhost:3000` (or set `PORT`).

## How a game plays

1. Host creates a room, everyone joins with the 4-digit code.
2. Roles are dealt: crewmates see the word, the imposter sees a vague hint that
   rotates each round.
3. Each round, players take turns giving one clue in the chat. 30 seconds each.
4. Once everyone has played, the host calls a vote. Vote someone out, or skip.
   Free chat is open during the vote so people can make their case.
5. Eject a crewmate and the game rolls on. You get 3 rounds per imposter.
6. **Eject the imposter and they get one last guess at the word.** Name it and
   the imposters steal the win.

Imposters also win by surviving all the rounds, or by reaching the crew in
numbers.

## The imposter's word guess

Two ways for the imposter to win by naming the word, both on by default and
switched off together with the **Imposter can guess the word** lobby setting:

- **Final words** — a caught imposter gets 25 seconds after their ejection to
  name the word. Correct, and the imposters win it back. Wrong or too slow, and
  the crew win.
- **Calling it** — a living imposter can gamble a guess at any point during the
  discussion. Correct is an instant win. Wrong and they blow their cover: they're
  out of the game.

Matching is forgiving. Case, accents, punctuation, spacing and a leading "the"
are all ignored, so `the EIFFEL tower!` matches `Eiffel Tower`.

Scoring: crew win = 1 point to each surviving crewmate. Imposter win = 2 points,
or **3** if they won by naming the word.

## Avatars

Twelve classic crewmate colours are drawn as inline SVG and offered first. Two
players in the same room can't wear the same colour — if you pick one that's
taken, you're quietly moved to the next free one.

You can add your own pictures on top of those. Drop images in:

`public/images/icons/`

Supported: `.png`, `.webp`, `.jpg`, `.jpeg`, `.gif`, `.svg`. The server scans
that folder automatically and offers whatever it finds under a "custom" divider
in the picker — there's no filename list to edit. The listing is cached for five
seconds, so a new file shows up on the next page load.

## Configuration

All optional, all milliseconds:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `TURN_DURATION_MS` | `30000` | Length of one clue turn |
| `GUESS_DURATION_MS` | `25000` | Length of the caught imposter's guess window |
| `RECONNECT_GRACE_MS` | `300000` | How long a seat is held for a disconnected player |
| `EJECTION_REVEAL_MS` | `3600` | Length of the ejection cutscene. Turn and guess clocks are scheduled to start only after it finishes, so nobody loses time to an animation they're still watching. Change it only if you also change the animation timing in `public/index.html`. |

## Reconnecting

A temporary disconnect does not remove a player — switching apps, locking a
phone, or changing network reconnects to the same seat, keeping their role,
score and alive/dead status. Seats are held for `RECONNECT_GRACE_MS`.

Host **powers** do not wait, though. If the host drops, the game hands the host
controls to a connected player immediately so the room never stalls; the original
host takes them back automatically when they return. A deliberate Leave removes a
player right away.

## Known limits

Rooms are in-process memory. A restart, redeploy, or free-tier spin-down erases
every room. For rooms that must survive that, move room state into Redis or
Postgres.
