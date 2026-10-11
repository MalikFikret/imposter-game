# Imposter · Sahtekâr · المحتال

A multilingual party word game for 3–10 players. Everyone gets the same secret word except the imposter, who has to bluff. Players give one-word clues, vote, and the caught imposter gets one last chance to guess the word.

- **Play:** https://malikfikret.github.io/imposter-game/
- **How to play:** [English](https://malikfikret.github.io/imposter-game/guide/en.html) · [Türkçe](https://malikfikret.github.io/imposter-game/guide/tr.html) · [العربية](https://malikfikret.github.io/imposter-game/guide/ar.html)
- **Admin panel:** `/admin.html` (restricted to the owner's Google account)

© 2026 Malik Fikret. All rights reserved. See [LICENSE](LICENSE).

---

## Features

| Area | What it does |
|---|---|
| Game modes | **Online room**: every player joins from their own phone with a 6-character code or invite link and votes on their own device. **Single-phone room**: one phone is passed around; votes are made out loud and marked on the phone. |
| Rounds | Random speaking order (the imposter speaks first only ~5% of the time), vote with explicit confirmation, automatic re-vote on ties, 60-second guess timer for a caught imposter, majority "did they guess it?" vote. |
| Scoring | Crew win: +1 to every crew member still in the round. Imposter win: +2 to each imposter. Per-room history and a score table (points, wins, rounds played, times as imposter). |
| Rooms | Private (code only) or public (listed on the main menu), editable rules (word language, categories, 1–2 imposters, category hint for the imposter), persistent across days. |
| Identity | No sign-up. Each device gets a Firebase anonymous identity. Players protect their seat with a 4-digit personal PIN; the host protects the room with a 6-digit room PIN. |
| Host tools | Kick (visible as "removed by the host"), approve name changes, hand over the host role (new host sets a new PIN), confirm whether to continue without a disconnected player or cancel the round. |
| Presence | Live online/offline dot per player, driven by Firebase `onDisconnect`. |
| Languages | UI and word lists in Turkish, Arabic (RTL) and English. Each language has its **own** word list per category (not translations). ~1,000 words per language. |
| Admin | Google sign-in page for the owner: all rooms, live stats, rename/kick players, reset room PIN, toggle public, clear history, delete rooms, purge rooms idle for 30+ days. |

## Architecture

```
Browser (GitHub Pages, static files)
 ├─ index.html + app.js      game UI (vanilla JS, ES modules, no build step)
 ├─ admin.html + admin.js    admin UI (separate Firebase app instance + Google sign-in)
 ├─ guide/*.html             how-to-play pages
 └─ Firebase JS SDK 10.12.2 (loaded from gstatic.com)
        │
        ├─ Firebase Authentication   anonymous (players) · Google (admin)
        └─ Firebase Realtime Database (europe-west1)  live state + security rules
```

There is no custom backend. All game logic runs in the clients; integrity is enforced by Realtime Database security rules (`database.rules.json`) and by atomic `runTransaction` writes on the shared game node.

### Data model

```
rooms/{CODE}                       CODE = 6 chars from A–Z, 2–9 (no 0/O/1/I/L)
  meta      {host: uid, hostSlot, mode: online|local, pinSet, createdAt}
  settings  {lang, cats[], hint, imps, public}
  players/{slot}  {name, uid, joinedAt, status: in|left|kicked, online, nameReq}
  members/{uid} = slot             which seat a device occupies (used by the rules)
  game      {phase, round, cat, wi, word, lang, hint, roster[], imps[], order[], pass[], out[], vr, caught, guessEnd, impWins, ...}
  votes/{slot}   {key: "round_voteRound", target}
  judges/{slot}  {round, yes}
  history/r{n}   {round, cat, word, lang, roster[], imps[], out[], caught, impWins, names{}, at}
  used/{cat}[_{lang}]/{index} = true      words already played in this room
publicRooms/{CODE}   {hostName, lang, players, phase, updatedAt}   listing for public rooms
secrets/{CODE}       {hostPin, pins/{slot}}    never readable by clients
claims/{CODE}/{uid}  {slot, pin, hostPin}      write-only proof used to take over a seat/host role
```

A **seat** (`slot`) is independent from the device identity (`uid`). This is what lets a player continue from another phone: they prove the seat's PIN and the seat is re-pointed to their new `uid`, keeping all their points.

### Game phases

```
online:  lobby → play → vote ⇄ tie → guess (60 s) → judge → result → (new round)
local:   lobby → cards → discuss → vote → guess (60 s) → judge → result
                          ↑ tie ─┘
```

Phase changes are done with `runTransaction` guarded on the expected phase/round, so concurrent clients cannot double-apply them. Results are written to `history/r{n}` with a create-only rule, so a round can never be scored twice. Scores are always derived from history, never stored as counters.

### Security model

| Rule | Effect |
|---|---|
| `auth != null` everywhere | Requests that do not come through the app (no anonymous session) are rejected. |
| No read on `rooms/` root | Rooms cannot be listed; you need the code. Public rooms are listed only through `publicRooms/`. |
| Host-only cascade on `rooms/{code}` | Only the current host can change settings, kick, reset history or delete. |
| Per-seat writes | A device can only write its own seat's `online`, `status` (`in`/`left`), `nameReq`, vote and judge answer. Names change only through host approval. |
| `secrets/` has no read rule | PINs are never readable. Ownership is proven by writing a guess to `claims/` and letting the rule compare it with the secret. |
| `history/r{n}` create-only | Results are immutable once written. |
| Admin | Root read/write only for one Google account UID. |

**Known limitations** (accepted for a friends' party game):

- Game state (including the secret word) lives in a node every room member can read, so a technical player could read it with developer tools.
- PIN guesses are not rate-limited by the database. A 6-digit room PIN has 1,000,000 combinations; use non-trivial PINs.
- The anonymous identity is tied to the browser. Clearing site data or using a private tab creates a new identity (the PINs exist for exactly this case).

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Game page shell |
| `app.js` | Game logic, rendering, Firebase access |
| `i18n.js` | Language registry (`LANGS`) and all UI strings |
| `words.js` | Word bank: categories × independent per-language lists |
| `style.css` | Shared styles (light/dark, RTL aware) |
| `admin.html`, `admin.js` | Admin panel |
| `guide/` | How-to-play pages (TR / AR / EN) |
| `database.rules.json` | Realtime Database security rules (paste into the Firebase console) |
| `tools/bump-version.py` | Release helper: bumps the version and cache-busting queries |
| `LICENSE` | Copyright notice |

## Local development

No build step is needed. Serve the repository root over HTTP (ES modules do not load from `file://`):

```bash
# run inside the repository folder, e.g. ~/projects/imposter-game
python3 -m http.server 8080
# then open http://localhost:8080/
```

`localhost` is already an authorized domain in Firebase Auth, so the local copy talks to the same Firebase project. Use a separate Firebase project if you need an isolated test database.

## Deployment

- **Site:** GitHub Pages serves the `main` branch root. Every push to `main` is live within 1–2 minutes. `.nojekyll` disables Jekyll processing.
- **Cache busting:** before each release run `python3 tools/bump-version.py X.Y.Z` from the repository root. It updates `APP_VERSION` and the `?v=` query on every local script/stylesheet so browsers fetch the new files instead of cached ones.
- **Rules:** changes to `database.rules.json` are **not** deployed automatically. Paste the file into *Firebase console → Realtime Database → Rules* and press *Publish*.
- **Auth:** Anonymous and Google providers must be enabled; `malikfikret.github.io` must be in *Authentication → Settings → Authorized domains*.

## Content

### Adding words

Open `words.js` and append to the end of the list for the right category and language. **Append only**: rooms remember played words by index, so reordering or deleting shifts that bookkeeping.

### Adding a language

1. Add an entry to `LANGS` in `i18n.js` (`code`, native `name`, `short`, `dir`, list separator).
2. Add a `STR.<code>` block with every UI key (copy `STR.en` as a template).
3. In `words.js`, add `names.<code>` and `words.<code>` (a native word list) to every category.
4. Optionally add `guide/<code>.html`.

No code changes are required.

## Credits

- Design, development and content: **Malik Fikret**
- Firebase (Google) for authentication and the realtime database
- Fonts via Google Fonts: Anton, Cairo, DM Sans, JetBrains Mono (SIL Open Font License)

## License

© 2026 Malik Fikret. All rights reserved. The source code is publicly visible for reference only; no permission is granted to copy, modify, redistribute or host it. See [LICENSE](LICENSE).
